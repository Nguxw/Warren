import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, AutomationSpec, Schedule, TaskSummary } from "@warren/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { describeSchedule, formatWhen, type MessageKey } from "../i18n.ts";
import { Clock, Folder, Globe, Package, Play, Plus } from "../icons.tsx";
import { FolderMenu, recentFolders } from "./Home.tsx";

/** Automations: what runs on a schedule, when it runs next, and how the last run went. */
export function AutomationsView(props: {
  tasks: readonly TaskSummary[];
  onOpenTask(id: string): void;
  /** Opens the editor at once, filled in, as "Run on a schedule…" on a task does. */
  draft?: Partial<AutomationSpec> | undefined;
  onDraftUsed(): void;
}) {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: ["automations"],
    queryFn: api.automations,
    refetchInterval: 30_000,
  });
  const [editing, setEditing] = useState<{
    automation?: Automation;
    draft?: Partial<AutomationSpec>;
  }>();
  const { draft, onDraftUsed } = props;
  useEffect(() => {
    if (draft) {
      setEditing({ draft });
      onDraftUsed();
    }
  }, [draft, onDraftUsed]);
  const automations = list.data ?? [];
  const now = Date.now();

  return (
    <article className="task-view automations-view">
      <header className="task-head">
        <div className="task-title">
          <h1>{t("auto.title")}</h1>
          <button type="button" className="button primary" onClick={() => setEditing({})}>
            <Plus size={15} />
            {t("auto.new")}
          </button>
        </div>
        <p className="triggers-intro">{t("auto.intro")}</p>
      </header>

      {list.error && <p className="notice error">{list.error.message}</p>}
      {list.data && automations.length === 0 && (
        <div className="auto-empty">
          <span className="confirm-icon accent">
            <Clock size={20} />
          </span>
          <p className="auto-empty-title">{t("auto.empty")}</p>
          <p className="muted">{t("auto.emptyHint")}</p>
          <button type="button" className="button" onClick={() => setEditing({})}>
            <Plus size={15} />
            {t("auto.new")}
          </button>
        </div>
      )}
      <div className="auto-list">
        {automations.map((automation) => (
          <AutomationCard
            key={automation.id}
            automation={automation}
            now={now}
            onEdit={() => setEditing({ automation })}
            onOpenTask={props.onOpenTask}
          />
        ))}
      </div>

      {editing && (
        <AutomationEditor
          tasks={props.tasks}
          automation={editing.automation}
          draft={editing.draft}
          onClose={() => setEditing(undefined)}
        />
      )}
    </article>
  );
}

function AutomationCard(props: {
  automation: Automation;
  now: number;
  onEdit(): void;
  onOpenTask(id: string): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const { automation: a } = props;
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["automations"] });
    client.invalidateQueries({ queryKey: ["tasks"] });
  };
  const toggle = useMutation({
    mutationFn: () => api.updateAutomation(a.id, { enabled: !a.enabled }),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: () => api.runAutomation(a.id),
    onSuccess: (taskId) => {
      refresh();
      if (taskId) props.onOpenTask(taskId);
    },
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => api.deleteAutomation(a.id), onSuccess: refresh });
  const name = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
  const last = a.lastRun;
  const error = (toggle.error ?? run.error ?? remove.error)?.message;

  return (
    <section className={`auto-card ${a.enabled ? "" : "paused"}`}>
      <div className="auto-main">
        <div className="auto-head">
          <span className="auto-icon">
            <Clock size={16} />
          </span>
          <h2>{a.name}</h2>
          <label className="toggle" title={t("auto.enabled")}>
            <input
              type="checkbox"
              checked={a.enabled}
              disabled={toggle.isPending}
              onChange={() => toggle.mutate()}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        </div>
        <p className="auto-when">
          <strong>{describeSchedule(t, a.schedule)}</strong>
          {" · "}
          {a.enabled && a.nextRunAt
            ? t("auto.next", { when: formatWhen(t, a.nextRunAt, props.now) })
            : t("auto.paused")}
        </p>
        <p className="auto-instruction">{a.instruction}</p>
        <p className="auto-meta">
          {a.repo && (
            <span title={a.repo}>
              <Folder size={13} />
              {name(a.repo)}
            </span>
          )}
          {a.outputDir && (
            <span title={a.outputDir}>
              <Package size={13} />
              {t("auto.saveTo", { dir: name(a.outputDir) })}
            </span>
          )}
          {a.network && (
            <span>
              <Globe size={13} />
              {t("meta.networkOn")}
            </span>
          )}
          <span className={last?.status === "skipped" ? "auto-skipped" : ""}>
            {!last
              ? t("auto.never")
              : last.status === "skipped"
                ? t("auto.lastSkipped", {
                    when: formatWhen(t, last.at, props.now),
                    reason: last.reason ?? "",
                  })
                : t("auto.lastStarted", { when: formatWhen(t, last.at, props.now) })}
          </span>
          {last?.taskId && (
            <button
              type="button"
              className="md-file-link"
              onClick={() => last.taskId && props.onOpenTask(last.taskId)}
            >
              {t("auto.viewTask")}
            </button>
          )}
        </p>
        {error && <p className="form-error">{error}</p>}
      </div>
      <div className="auto-actions">
        <button
          type="button"
          className="button small"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          <Play size={13} />
          {t("auto.runNow")}
        </button>
        <button type="button" className="button ghost small" onClick={props.onEdit}>
          {t("auto.edit")}
        </button>
        <button
          type="button"
          className="button ghost small danger"
          onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? t("auto.deleteConfirm") : t("auto.delete")}
        </button>
      </div>
    </section>
  );
}

const ROLES = ["main", "hard", "cheap"] as const;
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** Creates or edits an automation: what to do, when, on which folder, and where to save. */
export function AutomationEditor(props: {
  tasks: readonly TaskSummary[];
  automation?: Automation | undefined;
  draft?: Partial<AutomationSpec> | undefined;
  onClose(): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const start: Partial<AutomationSpec> = props.automation ?? props.draft ?? {};
  const [name, setName] = useState(start.name ?? "");
  const [instruction, setInstruction] = useState(start.instruction ?? "");
  const [schedule, setSchedule] = useState<Schedule>(
    start.schedule ?? { kind: "daily", time: "09:00" },
  );
  const [repo, setRepo] = useState(start.repo ?? "");
  const [outputDir, setOutputDir] = useState(start.outputDir ?? "");
  const [role, setRole] = useState(start.modelRole ?? "main");
  const [network, setNetwork] = useState(start.network ?? false);
  const recent = useMemo(() => recentFolders(props.tasks), [props.tasks]);
  const { onClose } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () => {
      const spec: AutomationSpec = {
        name: name.trim(),
        instruction: instruction.trim(),
        schedule,
        ...(repo && { repo }),
        ...(outputDir && { outputDir }),
        modelRole: role,
        network,
      };
      return props.automation
        ? // A cleared folder is sent empty, so the saved automation drops it.
          api.updateAutomation(props.automation.id, { ...spec, repo, outputDir })
        : api.createAutomation(spec);
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["automations"] });
      props.onClose();
    },
  });
  const ready = name.trim() && instruction.trim() && !save.isPending;
  const time = schedule.kind === "interval" ? "09:00" : schedule.time;
  const setKind = (kind: Schedule["kind"]) =>
    setSchedule(
      kind === "interval"
        ? { kind, hours: 6 }
        : kind === "weekly"
          ? { kind, days: [1, 2, 3, 4, 5], time }
          : { kind, time },
    );

  return (
    <div className="overlay">
      <button type="button" className="backdrop" aria-label={t("auto.cancel")} onClick={onClose} />
      <form
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-label={props.automation ? t("auto.editorEdit") : t("auto.editorNew")}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <h2>{props.automation ? t("auto.editorEdit") : t("auto.editorNew")}</h2>

        <label className="field">
          <span className="field-label">{t("auto.name")}</span>
          <input
            className="input"
            value={name}
            placeholder={t("auto.namePlaceholder")}
            // biome-ignore lint/a11y/noAutofocus: the editor opens to be filled in
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">{t("auto.instruction")}</span>
          <textarea
            className="input editor-text"
            rows={4}
            value={instruction}
            placeholder={t("auto.instructionPlaceholder")}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field-label">{t("auto.schedule")}</span>
          <div className="schedule-row">
            <div className="segmented">
              {(["daily", "weekly", "interval"] as const).map((kind) => (
                <label key={kind} className={schedule.kind === kind ? "on" : ""}>
                  <input
                    type="radio"
                    checked={schedule.kind === kind}
                    onChange={() => setKind(kind)}
                  />
                  {t(`auto.kind.${kind}`)}
                </label>
              ))}
            </div>
            {schedule.kind === "interval" ? (
              <label className="inline-field">
                {t("auto.hours")}
                <input
                  className="input narrow"
                  type="number"
                  min={1}
                  max={168}
                  value={schedule.hours}
                  onChange={(e) =>
                    setSchedule({
                      kind: "interval",
                      hours: Math.min(168, Math.max(1, Number(e.target.value) || 1)),
                    })
                  }
                />
              </label>
            ) : (
              <label className="inline-field">
                {t("auto.at")}
                <input
                  className="input narrow"
                  type="time"
                  value={schedule.time}
                  onChange={(e) =>
                    e.target.value && setSchedule({ ...schedule, time: e.target.value })
                  }
                />
              </label>
            )}
          </div>
          {schedule.kind === "weekly" && (
            <div className="weekdays">
              {WEEK.map((day) => {
                const on = schedule.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`weekday ${on ? "on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const days = on
                        ? schedule.days.filter((d) => d !== day)
                        : [...schedule.days, day];
                      if (days.length > 0) setSchedule({ ...schedule, days });
                    }}
                  >
                    {t(`weekday.${day}` as MessageKey)}
                  </button>
                );
              })}
            </div>
          )}
          <p className="field-hint">{describeSchedule(t, schedule)}</p>
        </div>

        <div className="editor-bar">
          <FolderMenu
            icon={<Folder size={14} />}
            label={t("new.repo")}
            value={repo}
            options={recent}
            hint={t("new.repoHint")}
            prompt={t("new.choosePrompt")}
            placeholder={t("new.repoPlaceholder")}
            placement="below"
            onChange={setRepo}
          />
          <FolderMenu
            icon={<Package size={14} />}
            label={t("new.output")}
            value={outputDir}
            options={[]}
            hint={t("auto.outputHint")}
            prompt={t("new.outputPrompt")}
            placeholder={t("new.outputPlaceholder")}
            placement="below"
            onChange={setOutputDir}
          />
          <div className="segmented small">
            {ROLES.map((value) => (
              <label key={value} className={role === value ? "on" : ""}>
                <input type="radio" checked={role === value} onChange={() => setRole(value)} />
                {t(`new.model.${value}`)}
              </label>
            ))}
          </div>
          <button
            type="button"
            className={`bar-button ${network ? "on" : ""}`}
            aria-pressed={network}
            onClick={() => setNetwork(!network)}
          >
            <Globe size={14} />
            {network ? t("home.networkOn") : t("home.networkOff")}
          </button>
        </div>

        {save.error && <p className="form-error">{save.error.message}</p>}
        <footer>
          <button type="button" className="button ghost" onClick={onClose}>
            {t("auto.cancel")}
          </button>
          <button type="submit" className="button primary" disabled={!ready}>
            {props.automation ? t("auto.save") : t("auto.create")}
          </button>
        </footer>
      </form>
    </div>
  );
}

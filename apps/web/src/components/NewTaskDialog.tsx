import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@warren/protocol";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { Close, Folder, Globe } from "../icons.tsx";

const ROLES = ["main", "hard", "cheap"] as const;

/** Recent repositories, newest first, from the tasks the daemon already knows. */
function recentRepos(tasks: readonly TaskSummary[]): { name: string; path: string }[] {
  const seen = new Map<string, { name: string; path: string; at: number }>();
  for (const task of tasks) {
    if (!task.repoPath || !task.repo) continue;
    const known = seen.get(task.repoPath);
    if (!known || known.at < task.updatedAt) {
      seen.set(task.repoPath, { name: task.repo, path: task.repoPath, at: task.updatedAt });
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 6);
}

export function NewTaskDialog(props: {
  tasks: readonly TaskSummary[];
  onClose(): void;
  onCreated(id: string): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const recent = useMemo(() => recentRepos(props.tasks), [props.tasks]);
  const [instruction, setInstruction] = useState("");
  const [repo, setRepo] = useState(recent[0]?.path ?? "");
  const [modelRole, setModelRole] = useState<(typeof ROLES)[number]>("main");
  const [network, setNetwork] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const create = useMutation({
    mutationFn: () =>
      api.create({
        instruction,
        modelRole,
        network,
        ...(repo.trim() && { repo: repo.trim() }),
      }),
    onSuccess: (task) => {
      client.invalidateQueries({ queryKey: ["tasks"] });
      props.onCreated(task.id);
    },
  });
  const ready = instruction.trim().length > 0 && !create.isPending;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) create.mutate();
  };

  return (
    <div className="overlay">
      <button
        type="button"
        className="backdrop"
        aria-label={t("new.cancel")}
        onClick={props.onClose}
      />
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("new.title")}
        onSubmit={submit}
      >
        <header className="dialog-head">
          <h2>{t("new.title")}</h2>
          <button type="button" className="icon-button" onClick={props.onClose} title="Esc">
            <Close />
          </button>
        </header>

        <textarea
          ref={input}
          className="instruction-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={5}
          placeholder={t("new.placeholder")}
        />

        <div className="field">
          <span className="field-label">
            <Folder size={14} />
            {t("new.repo")}
          </span>
          <div className="chips">
            <button
              type="button"
              className={`chip ${repo === "" ? "on" : ""}`}
              onClick={() => setRepo("")}
            >
              {t("new.repoNone")}
            </button>
            {recent.map((item) => (
              <button
                key={item.path}
                type="button"
                className={`chip ${repo === item.path ? "on" : ""}`}
                onClick={() => setRepo(item.path)}
                title={item.path}
              >
                {item.name}
              </button>
            ))}
          </div>
          <input
            className="path-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={t("new.repoPlaceholder")}
            spellCheck={false}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <span className="field-label">{t("new.model")}</span>
            <div className="segmented">
              {ROLES.map((role) => (
                <label key={role} className={modelRole === role ? "on" : ""}>
                  <input
                    type="radio"
                    name="model-role"
                    value={role}
                    checked={modelRole === role}
                    onChange={() => setModelRole(role)}
                  />
                  {t(`new.model.${role}`)}
                </label>
              ))}
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={network}
              onChange={(e) => setNetwork(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <span className="toggle-title">
                <Globe size={14} />
                {t("new.network")}
              </span>
              <span className="toggle-hint">{t("new.networkHint")}</span>
            </span>
          </label>
        </div>

        {create.error && <p className="form-error">{create.error.message}</p>}

        <footer className="dialog-foot">
          <kbd>⌘↩</kbd>
          <button type="button" className="button ghost" onClick={props.onClose}>
            {t("new.cancel")}
          </button>
          <button type="submit" className="button primary" disabled={!ready}>
            {create.isPending ? t("new.starting") : t("new.start")}
          </button>
        </footer>
      </form>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { foldEvents, statusOf } from "@warren/core";
import { type AutomationSpec, automationOf } from "@warren/protocol";
import { useMemo, useState } from "react";
import { api, type TaskView as Task } from "../api.ts";
import { useI18n, useNow } from "../context.tsx";
import { formatDuration, stepLabel } from "../i18n.ts";
import {
  ArrowUp,
  Branch,
  Check,
  Clock,
  Coin,
  Cpu,
  Download,
  Folder,
  Globe,
  History,
  Offline,
  Package,
  Pause,
  Play,
  PullRequest,
  Reveal,
  Sparkle,
  Stop,
  Trash,
} from "../icons.tsx";
import { useEnterToSend } from "../keys.ts";
import {
  argsPreview,
  categoryOf,
  compact,
  currentStep,
  deliverables,
  displayTitle,
  type KeyedEntry,
  lastModel,
  primaryArtifact,
  timeline,
} from "../model.ts";
import { Activity } from "./Activity.tsx";
import { Changes } from "./Changes.tsx";
import { Files, Location } from "./Files.tsx";
import { Markdown } from "./Markdown.tsx";
import { StatusIcon } from "./Sidebar.tsx";

export function TaskView({
  id,
  onDelete,
  onSchedule,
}: {
  id: string;
  onDelete(task: { id: string; title: string; status: string }): void;
  /** Opens a new automation that repeats this task. */
  onSchedule(draft: Partial<AutomationSpec>): void;
}) {
  const { t } = useI18n();
  const task = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id) });
  const events = useQuery({ queryKey: ["events", id], queryFn: () => api.events(id) });
  const hasRepo = task.data?.grant.workspace.kind === "clone";
  const diff = useQuery({
    queryKey: ["diff", id],
    queryFn: () => api.diff(id),
    enabled: hasRepo,
    staleTime: 5_000,
  });
  const files = useQuery({ queryKey: ["files", id], queryFn: () => api.files(id) });
  const [tab, setTab] = useState<"activity" | "changes" | "files">("activity");
  const [openFile, setOpenFile] = useState<string>();
  const [replaying, setReplaying] = useState(false);
  const [replayAt, setReplayAt] = useState(0);

  const all = events.data ?? [];
  const last = all.at(-1)?.seq ?? 0;
  const visible = replaying ? all.filter((e) => e.seq <= replayAt) : all;
  const entries = useMemo(() => timeline(visible), [visible]);

  if (task.error) return <p className="empty-note">{task.error.message}</p>;
  if (!task.data || !events.data) return <p className="empty-note">{t("app.loading")}</p>;

  // Replaying folds the log up to the chosen step, exactly as a restart would.
  const replayed = replaying ? foldEvents(visible) : undefined;
  const shown: Task = replayed ? { ...replayed, status: statusOf(replayed) } : task.data;
  const changeCount = diff.data?.files.length ?? 0;
  const fileCount = files.data?.files.length ?? 0;
  // A repository task's result is its change; any other task's result is the files it wrote.
  const resultTab = hasRepo ? "changes" : "files";
  const resultCount = hasRepo ? changeCount : fileCount;

  return (
    <article className="task-view">
      <TaskHeader
        task={shown}
        model={lastModel(visible)}
        onDelete={() => onDelete(task.data)}
        live={!replaying}
        replaying={replaying}
        onReplay={() => {
          setReplaying(!replaying);
          setReplayAt(last);
        }}
      />

      {replaying ? (
        <div className="replay-bar">
          <History size={15} />
          <span className="replay-step">{t("replay.step", { step: replayAt, max: last })}</span>
          <input
            type="range"
            min={0}
            max={last}
            value={replayAt}
            onChange={(e) => setReplayAt(Number(e.target.value))}
          />
          <button type="button" className="button ghost small" onClick={() => setReplaying(false)}>
            {t("replay.back")}
          </button>
        </div>
      ) : (
        <StatusCard
          task={task.data}
          entries={entries}
          diff={diff.data}
          files={hasRepo ? undefined : files.data?.files}
          onChanges={() => setTab("changes")}
          onSchedule={() => onSchedule(draftOf(task.data))}
          onFile={(path) => {
            setOpenFile(path);
            setTab("files");
          }}
        />
      )}

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          className={tab === "activity" ? "on" : ""}
          onClick={() => setTab("activity")}
        >
          {t("tab.activity")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === resultTab}
          className={tab === resultTab ? "on" : ""}
          onClick={() => setTab(resultTab)}
        >
          {t(hasRepo ? "tab.changes" : "tab.files")}
          {resultCount > 0 && <span className="count">{resultCount}</span>}
        </button>
      </div>

      <div className="task-body">
        {tab === "changes" && hasRepo ? (
          <>
            {files.data && <Location taskId={id} root={files.data.root} />}
            <Changes diff={diff.data} loading={diff.isLoading} error={diff.error} />
          </>
        ) : tab === "files" && !hasRepo ? (
          <Files
            taskId={id}
            source={
              task.data.grant.workspace.kind === "copy"
                ? task.data.grant.workspace.source
                : undefined
            }
            list={files.data}
            loading={files.isLoading}
            error={files.error}
            selected={openFile}
            onSelect={setOpenFile}
          />
        ) : (
          <Activity
            entries={entries}
            onFile={
              hasRepo
                ? undefined
                : (path) => {
                    setOpenFile(path);
                    setTab("files");
                  }
            }
          />
        )}
      </div>

      {!replaying && <Composer task={task.data} />}
    </article>
  );
}

function TaskHeader(props: {
  task: Task;
  /** The model that answered last. */
  model: string | undefined;
  onDelete(): void;
  live: boolean;
  replaying: boolean;
  onReplay(): void;
}) {
  const { t } = useI18n();
  const { task } = props;
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") => api.control(task.id, action),
  });
  const now = useNow(task.status === "active");
  const end = task.ended?.at ?? (task.status === "active" ? now : task.updatedAt);
  const repo = task.grant.workspace.kind !== "none" ? task.grant.workspace.source : undefined;

  return (
    <header className="task-head">
      <div className="task-title">
        <StatusIcon status={task.status} outcome={task.ended?.outcome} size={22} />
        <h1>{displayTitle(task.title, repo?.split("/").at(-1))}</h1>
        <div className="head-actions">
          <button
            type="button"
            className={`icon-button ${props.replaying ? "on" : ""}`}
            title={t("action.replay")}
            onClick={props.onReplay}
          >
            <History />
          </button>
          {!props.replaying && (
            <button
              type="button"
              className="icon-button danger"
              title={t("delete.action")}
              onClick={props.onDelete}
            >
              <Trash />
            </button>
          )}
          {props.live && task.status !== "ended" && (
            <>
              {task.status === "paused" ? (
                <button
                  type="button"
                  className="icon-button"
                  title={t("action.resume")}
                  onClick={() => control.mutate("resume")}
                >
                  <Play />
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  title={t("action.pause")}
                  onClick={() => control.mutate("pause")}
                >
                  <Pause />
                </button>
              )}
              <button
                type="button"
                className="icon-button danger"
                title={t("action.cancel")}
                onClick={() => control.mutate("cancel")}
              >
                <Stop />
              </button>
            </>
          )}
        </div>
      </div>
      <p className="task-meta">
        {repo && (
          <span title={repo}>
            <Folder size={13} />
            {repo.split("/").at(-1)}
          </span>
        )}
        {automationOf(task.trigger) && (
          <span className="meta-automation">
            <Clock size={13} />
            {t("auto.badge")}
          </span>
        )}
        {task.skills.length > 0 && (
          <span className="meta-skills" title={t("meta.skills")}>
            <Sparkle size={13} />
            {task.skills.join(" · ")}
          </span>
        )}
        <span title={t("meta.modelTitle")}>
          <Cpu size={13} />
          {task.modelRole ?? "main"}
          {props.model && <span className="meta-model">{props.model}</span>}
        </span>
        <span>
          {task.grant.network ? <Globe size={13} /> : <Offline size={13} />}
          {task.grant.network ? t("meta.networkOn") : t("meta.networkOff")}
        </span>
        <span>
          <Clock size={13} />
          {formatDuration(t, end - task.createdAt)}
        </span>
        <span
          title={t("meta.usage", {
            input: compact(task.usage.inputTokens),
            cached: compact(task.usage.cachedInputTokens),
            output: compact(task.usage.outputTokens),
            reasoning: compact(task.usage.reasoningTokens),
          })}
        >
          <Coin size={13} />${task.usage.costUsd.toFixed(3)} ·{" "}
          {t("meta.calls", { n: task.usage.modelCalls })}
        </span>
      </p>
      {control.error && <p className="form-error">{control.error.message}</p>}
    </header>
  );
}

function StatusCard(props: {
  task: Task;
  entries: KeyedEntry[];
  diff: { files: { additions: number; deletions: number }[] } | undefined;
  /** For a task without a repository: the files it wrote, newest first. */
  files: { path: string }[] | undefined;
  onChanges(): void;
  onFile(path: string): void;
  onSchedule(): void;
}) {
  const { t } = useI18n();
  const { task } = props;
  const now = useNow(task.status === "active");

  if (task.status === "waiting") {
    return (
      <section className="status-card waiting">
        {task.attention.map((item) => (
          <AttentionForm key={item.attentionId} taskId={task.id} item={item} />
        ))}
      </section>
    );
  }

  if (task.status === "active") {
    const step = currentStep(props.entries);
    return (
      <section className="status-card active">
        <span className="spinner" />
        <div>
          <p className="card-title">
            {step ? stepLabel(t, categoryOf(step.name)) : t("card.thinking")}
            {step && <code>{argsPreview(step.args, 80)}</code>}
          </p>
          <p className="card-sub">
            {t("card.elapsed", { duration: formatDuration(t, now - task.createdAt) })}
          </p>
        </div>
      </section>
    );
  }

  if (task.status === "idle" || task.status === "paused") {
    return <PausedOrIdle task={task} />;
  }

  const outcome = task.ended?.outcome ?? "completed";
  const result = deliverables(props.entries);
  const produced = props.files ?? [];
  const primary = primaryArtifact(produced);
  const files = props.diff?.files ?? [];
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <section className={`status-card ended ${outcome}`}>
      <p className="card-title">{t(`card.${outcome}`)}</p>
      {task.ended?.summary && (
        <div className="card-summary">
          <Markdown onFile={props.onFile}>{task.ended.summary}</Markdown>
        </div>
      )}
      <div className="card-chips">
        {result.branch && (
          <span className="chip static">
            <Branch size={14} />
            {t("card.branch", { branch: result.branch })}
          </span>
        )}
        {result.pullRequest && (
          <a className="chip" href={result.pullRequest.url} target="_blank" rel="noreferrer">
            <PullRequest size={14} />
            {t("card.pr", { number: result.pullRequest.number })}
          </a>
        )}
        {primary && (
          <button type="button" className="chip primary" onClick={() => props.onFile(primary.path)}>
            <Package size={14} />
            {t("card.open", { name: primary.path.split("/").at(-1) ?? primary.path })}
          </button>
        )}
        {produced.length > 1 && (
          <button type="button" className="chip" onClick={() => props.onFile(primary?.path ?? "")}>
            {t("card.files", { n: produced.length })}
          </button>
        )}
        {(produced.length > 0 || props.diff) && <RevealChip taskId={task.id} />}
        {produced.length > 0 && <SaveChip task={task} />}
        {!automationOf(task.trigger) && (
          <button type="button" className="chip" onClick={props.onSchedule}>
            <Clock size={14} />
            {t("auto.fromTask")}
          </button>
        )}
        {props.diff && (
          <button type="button" className="chip" onClick={props.onChanges}>
            {files.length > 0
              ? t("card.changes", { files: files.length, add, del })
              : t("card.noChanges")}
          </button>
        )}
      </div>
    </section>
  );
}

/** A new automation's fields, taken from a task that is to be repeated. */
function draftOf(task: Task): Partial<AutomationSpec> {
  const { workspace } = task.grant;
  return {
    name: task.title,
    instruction: task.instruction,
    ...(workspace.kind !== "none" && { repo: workspace.source }),
    ...(task.outputDir && { outputDir: task.outputDir }),
    ...(task.modelRole && { modelRole: task.modelRole }),
    network: task.grant.network,
  };
}

function RevealChip({ taskId }: { taskId: string }) {
  const { t } = useI18n();
  const reveal = useMutation({ mutationFn: () => api.reveal(taskId) });
  return (
    <button
      type="button"
      className="chip"
      title={reveal.error?.message}
      onClick={() => reveal.mutate()}
    >
      <Reveal size={14} />
      {t("card.reveal")}
    </button>
  );
}

/**
 * Saving the task's files to a folder of the person's: the one chosen when the task was created,
 * or one picked now. Once saved, the chip shows where and opens it in Finder.
 */
function SaveChip({ task }: { task: Task }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      const dir = task.outputDir ?? (await api.pickFolder(t("new.outputPrompt")));
      return dir ? api.save(task.id, dir) : undefined;
    },
    onSuccess: (result) => {
      if (result) client.setQueryData(["task", task.id], result.task);
    },
  });
  const reveal = useMutation({ mutationFn: () => api.reveal(task.id, { saved: true }) });
  const last = task.exports.at(-1);
  const name = (path: string) => path.split("/").at(-1) ?? path;
  const error = (save.error ?? reveal.error)?.message;

  if (last) {
    return (
      <button
        type="button"
        className="chip saved"
        title={error ?? last.destination}
        onClick={() => reveal.mutate()}
      >
        <Check size={14} />
        {t("card.saved", { dir: name(last.destination) })}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="chip"
      title={error ?? task.outputDir}
      disabled={save.isPending}
      onClick={() => save.mutate()}
    >
      <Download size={14} />
      {task.outputDir ? t("card.save", { dir: name(task.outputDir) }) : t("card.saveChoose")}
    </button>
  );
}

function PausedOrIdle({ task }: { task: Task }) {
  const { t } = useI18n();
  const resume = useMutation({ mutationFn: () => api.control(task.id, "resume") });
  if (task.status === "idle") {
    return (
      <section className="status-card idle">
        <p className="card-title">{t("card.idle")}</p>
        <p className="card-sub">{t("card.idleHint")}</p>
      </section>
    );
  }
  return (
    <section className="status-card paused">
      <div>
        <p className="card-title">{t("card.paused")}</p>
        {task.paused?.reason && <p className="card-sub">{task.paused.reason}</p>}
      </div>
      <button type="button" className="button" onClick={() => resume.mutate()}>
        <Play size={14} />
        {t("card.resume")}
      </button>
    </section>
  );
}

function AttentionForm(props: { taskId: string; item: Task["attention"][number] }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const resolve = useMutation({
    mutationFn: (approved?: boolean) =>
      api.resolve(props.taskId, props.item.attentionId, text, approved),
  });
  const approval = props.item.kind === "approval";
  const answer = () => {
    if (!approval && text.trim()) resolve.mutate(undefined);
  };
  const enter = useEnterToSend<HTMLTextAreaElement>(answer);
  return (
    <div className="attention-form">
      <p className="card-label">{approval ? t("card.approval") : t("card.question")}</p>
      <div className="card-prompt">
        <Markdown>{props.item.prompt}</Markdown>
      </div>
      <div className="answer-box">
        <textarea
          rows={approval ? 1 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          {...enter}
          placeholder={approval ? t("card.denyNote") : t("card.answerPlaceholder")}
        />
        <div className="answer-actions">
          {approval ? (
            <>
              <button
                type="button"
                className="button ghost danger"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(false)}
              >
                {t("card.deny")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(true)}
              >
                {t("card.approve")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={!text.trim() || resolve.isPending}
              onClick={answer}
            >
              {t("card.answer")}
            </button>
          )}
        </div>
      </div>
      {resolve.error && <p className="form-error">{resolve.error.message}</p>}
    </div>
  );
}

function Composer({ task }: { task: Task }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => api.send(task.id, text),
    onSuccess: () => setText(""),
  });
  const submit = () => {
    if (text.trim() && !send.isPending) send.mutate();
  };
  const enter = useEnterToSend<HTMLTextAreaElement>(submit);
  if (task.status === "ended") return <p className="composer-closed">{t("composer.ended")}</p>;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        {...enter}
        placeholder={task.status === "idle" ? t("composer.reply") : t("composer.add")}
      />
      <span className="composer-hint">{t("composer.hint")}</span>
      <button
        type="submit"
        className="send"
        disabled={!text.trim() || send.isPending}
        title={t("composer.send")}
      >
        <ArrowUp size={16} />
      </button>
      {send.error && <p className="form-error">{send.error.message}</p>}
    </form>
  );
}

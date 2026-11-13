import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { foldEvents, statusOf } from "@warren/core";
import type { TaskEvent, TaskStatus, TaskSummary } from "@warren/protocol";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, subscribe, type TaskView, Unauthorized } from "./api.ts";
import {
  formatAgo,
  type Lang,
  type MessageKey,
  savedLang,
  saveLang,
  statusLabel,
  type Translate,
  translator,
} from "./i18n.ts";
import {
  argsPreview,
  compact,
  type Entry,
  groupTasks,
  type KeyedEntry,
  type Notice,
  shortId,
  type ToolStatus,
  timeline,
} from "./model.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof Unauthorized) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

// ------------------------------------------------------------------ language

const I18n = createContext<{ lang: Lang; t: Translate; setLang: (lang: Lang) => void }>({
  lang: "zh",
  t: translator("zh"),
  setLang: () => {},
});

function useI18n() {
  return useContext(I18n);
}

export function App() {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const i18n = useMemo(
    () => ({
      lang,
      t: translator(lang),
      setLang: (next: Lang) => {
        saveLang(next);
        setLangState(next);
      },
    }),
    [lang],
  );
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  return (
    <I18n.Provider value={i18n}>
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </I18n.Provider>
  );
}

function initialSelection(): string | null {
  return new URLSearchParams(window.location.search).get("task");
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  useLiveUpdates(!tasks.isError);

  const select = (id: string | null) => {
    setSelected(id);
    setCreating(false);
    history.replaceState(null, "", id ? `?task=${id}` : window.location.pathname);
  };

  if (tasks.error instanceof Unauthorized) return <SignIn />;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <span className="logo" aria-hidden>
            ◖
          </span>
          Warren
          {health.data && (
            <span className={`sandbox ${health.data.sandbox === "none" ? "off" : ""}`}>
              {health.data.sandbox === "none" ? t("app.noSandbox") : health.data.sandbox}
            </span>
          )}
          <button
            type="button"
            className="lang"
            title={t("app.switchLangTitle")}
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {t("app.switchLang")}
          </button>
        </header>
        <button
          type="button"
          className="primary new-task"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >
          {t("app.newTask")}
        </button>
        {tasks.isLoading && <p className="muted pad">{t("app.loading")}</p>}
        {tasks.error && !(tasks.error instanceof Unauthorized) && (
          <p className="error pad">{t("app.unreachable")}</p>
        )}
        {tasks.data && <Inbox tasks={tasks.data} selected={selected} onSelect={select} />}
      </aside>
      <main className="main">
        {creating ? (
          <NewTask onCreated={(id) => select(id)} />
        ) : selected ? (
          <TaskDetail key={selected} id={selected} />
        ) : (
          <Empty count={tasks.data?.length ?? 0} />
        )}
      </main>
    </div>
  );
}

/** Keeps every query current from the daemon's event stream. */
function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stop = () => {};
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const touched = new Set<string>();
    const flush = () => {
      pending = undefined;
      client.invalidateQueries({ queryKey: ["tasks"] });
      for (const id of touched) client.invalidateQueries({ queryKey: ["task", id] });
      touched.clear();
    };
    api
      .cursor()
      .then((cursor) => {
        if (cancelled) return;
        stop = subscribe(cursor, (event) => {
          client.setQueryData<TaskEvent[]>(["events", event.taskId], (events) =>
            events && !events.some((e) => e.seq === event.seq) ? [...events, event] : events,
          );
          touched.add(event.taskId);
          pending ??= setTimeout(flush, 150);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop();
      if (pending) clearTimeout(pending);
    };
  }, [enabled, client]);
}

function SignIn() {
  const { t } = useI18n();
  return (
    <div className="signin">
      <h1>Warren</h1>
      <p>{t("signin.body")}</p>
      <pre>warren open</pre>
    </div>
  );
}

function Empty({ count }: { count: number }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <h2>{count === 0 ? t("empty.none") : t("empty.unselected")}</h2>
      <p className="muted">{count === 0 ? t("empty.noneHint") : t("empty.unselectedHint")}</p>
    </div>
  );
}

// ------------------------------------------------------------------ inbox

const GROUPS: { key: keyof ReturnType<typeof groupTasks>; label: MessageKey }[] = [
  { key: "needsYou", label: "group.needsYou" },
  { key: "working", label: "group.working" },
  { key: "idle", label: "group.idle" },
  { key: "paused", label: "group.paused" },
  { key: "ended", label: "group.ended" },
];

function Inbox(props: {
  tasks: TaskSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const groups = useMemo(() => groupTasks(props.tasks), [props.tasks]);
  const now = Date.now();
  return (
    <nav className="inbox">
      {GROUPS.map(({ key, label }) =>
        groups[key].length === 0 ? null : (
          <section key={key}>
            <h3>
              {t(label)} <span className="count">{groups[key].length}</span>
            </h3>
            <ul>
              {groups[key].slice(0, key === "ended" ? 30 : undefined).map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`task-row ${props.selected === task.id ? "selected" : ""}`}
                    onClick={() => props.onSelect(task.id)}
                  >
                    <span className="row-top">
                      <StatusDot status={task.status} />
                      <span className="title">{task.title}</span>
                    </span>
                    {task.attention?.[0] && (
                      <span className="row-attention">
                        {task.attention[0].kind === "approval" ? t("row.approve") : t("row.asks")}
                        {task.attention[0].prompt}
                      </span>
                    )}
                    <span className="row-meta">
                      {shortId(task.id)} · {formatAgo(t, now - task.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </nav>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const { t } = useI18n();
  return <span className={`status-dot ${status}`} title={statusLabel(t, status)} />;
}

// ------------------------------------------------------------------ new task

function NewTask({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const [repo, setRepo] = useState("");
  const [modelRole, setModelRole] = useState("main");
  const [network, setNetwork] = useState(false);
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
      onCreated(task.id);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (instruction.trim()) create.mutate();
  };
  return (
    <form className="new-task-form" onSubmit={submit}>
      <h2>{t("new.title")}</h2>
      <label>
        <span>{t("new.instruction")}</span>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={6}
          placeholder={t("new.instructionPlaceholder")}
        />
      </label>
      <label>
        <span>
          {t("new.repo")} <span className="muted">{t("new.repoHint")}</span>
        </span>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder={t("new.repoPlaceholder")}
          spellCheck={false}
        />
      </label>
      <div className="row">
        <label>
          <span>{t("new.model")}</span>
          <select value={modelRole} onChange={(e) => setModelRole(e.target.value)}>
            <option value="main">main</option>
            <option value="hard">hard</option>
            <option value="cheap">cheap</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />
          <span>
            {t("new.network")} <span className="muted">{t("new.networkHint")}</span>
          </span>
        </label>
      </div>
      {create.error && <p className="error">{create.error.message}</p>}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={!instruction.trim() || create.isPending}
        >
          {create.isPending ? t("new.starting") : t("new.start")}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ task

function TaskDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const task = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id) });
  const events = useQuery({ queryKey: ["events", id], queryFn: () => api.events(id) });
  const [replayAt, setReplayAt] = useState<number | null>(null);

  if (task.error) return <p className="error pad">{task.error.message}</p>;
  if (!task.data || !events.data) return <p className="muted pad">{t("app.loading")}</p>;

  const all = events.data;
  const last = all.at(-1)?.seq ?? 0;
  const visible = replayAt === null ? all : all.filter((e) => e.seq <= replayAt);
  const replaying = replayAt !== null && replayAt < last;
  // Replaying folds the log up to the chosen step, exactly as a restart would.
  const replayed = replaying ? foldEvents(visible) : undefined;
  const shown: TaskView = replayed ? { ...replayed, status: statusOf(replayed) } : task.data;

  return (
    <article className="task">
      <TaskHeader task={shown} live={!replaying} />
      {!replaying && <AttentionPanel task={task.data} />}
      {all.length > 2 && (
        <Replay
          max={last}
          value={replayAt}
          onChange={(seq) => setReplayAt(seq >= last ? null : seq)}
        />
      )}
      <Timeline entries={timeline(visible)} />
      {!replaying && <Composer task={task.data} />}
    </article>
  );
}

function TaskHeader({ task, live }: { task: TaskView; live: boolean }) {
  const { t } = useI18n();
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") => api.control(task.id, action),
  });
  const { usage, grant } = task;
  const repo = grant.workspace.kind === "clone" ? grant.workspace.source.split("/").at(-1) : null;
  return (
    <header className="task-header">
      <div className="title-row">
        <h1>{task.title}</h1>
        <span className={`pill ${task.status}`}>{statusLabel(t, task.status)}</span>
      </div>
      <p className="meta">
        <span>{shortId(task.id)}</span>
        <span>{t("meta.model", { role: task.modelRole ?? "main" })}</span>
        {repo && <span>{t("meta.repo", { repo })}</span>}
        <span>{grant.network ? t("meta.networkOn") : t("meta.networkOff")}</span>
        <span>
          {t("meta.usage", {
            calls: usage.modelCalls,
            input: compact(usage.inputTokens),
            cached: compact(usage.cachedInputTokens),
            output: compact(usage.outputTokens),
            cost: `$${usage.costUsd.toFixed(4)}`,
          })}
        </span>
      </p>
      {live && task.status !== "ended" && (
        <div className="controls">
          {task.status === "paused" ? (
            <button type="button" onClick={() => control.mutate("resume")}>
              {t("control.resume")}
            </button>
          ) : (
            <button type="button" onClick={() => control.mutate("pause")}>
              {t("control.pause")}
            </button>
          )}
          <button type="button" className="danger" onClick={() => control.mutate("cancel")}>
            {t("control.cancel")}
          </button>
          {control.error && <span className="error">{control.error.message}</span>}
        </div>
      )}
    </header>
  );
}

function AttentionPanel({ task }: { task: TaskView }) {
  if (task.attention.length === 0) return null;
  return (
    <section className="attention-panel">
      {task.attention.map((item) => (
        <AttentionItem key={item.attentionId} taskId={task.id} item={item} />
      ))}
    </section>
  );
}

function AttentionItem(props: { taskId: string; item: TaskView["attention"][number] }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const resolve = useMutation({
    mutationFn: (approved?: boolean) =>
      api.resolve(props.taskId, props.item.attentionId, text, approved),
  });
  const approval = props.item.kind === "approval";
  return (
    <div className={`attention ${props.item.kind}`}>
      <p className="attention-label">
        {approval ? t("attention.approval") : t("attention.question")}
      </p>
      <p className="attention-prompt">{props.item.prompt}</p>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={approval ? t("attention.notePlaceholder") : t("attention.answerPlaceholder")}
      />
      <div className="actions">
        {approval ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate(true)}
            >
              {t("attention.approve")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate(false)}
            >
              {t("attention.deny")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!text.trim() || resolve.isPending}
            onClick={() => resolve.mutate(undefined)}
          >
            {t("attention.answer")}
          </button>
        )}
        {resolve.error && <span className="error">{resolve.error.message}</span>}
      </div>
    </div>
  );
}

function Replay(props: { max: number; value: number | null; onChange: (seq: number) => void }) {
  const { t } = useI18n();
  const value = props.value ?? props.max;
  return (
    <div className="replay">
      <label>
        <span>
          {props.value === null
            ? t("replay.live")
            : t("replay.step", { step: value, max: props.max })}
        </span>
        <input
          type="range"
          min={0}
          max={props.max}
          value={value}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
      </label>
      {props.value !== null && (
        <button type="button" onClick={() => props.onChange(props.max)}>
          {t("replay.back")}
        </button>
      )}
    </div>
  );
}

function Timeline({ entries }: { entries: KeyedEntry[] }) {
  return (
    <ol className="timeline">
      {entries.map((entry) => (
        <li key={entry.key} className={`entry entry-${entry.kind}`}>
          <EntryView entry={entry} />
        </li>
      ))}
    </ol>
  );
}

function EntryView({ entry }: { entry: Entry }): ReactNode {
  const { t } = useI18n();
  const time = new Date(entry.at).toLocaleTimeString();
  switch (entry.kind) {
    case "instruction":
      return (
        <div className="bubble instruction" title={time}>
          <span className="who">{t("who.task")}</span>
          <p>{entry.text}</p>
        </div>
      );
    case "user":
      return (
        <div className="bubble user" title={time}>
          <span className="who">{t("who.you")}</span>
          <p>{entry.text}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="bubble assistant" title={time}>
          <span className="who">{t("who.warren")}</span>
          <p>{entry.text}</p>
        </div>
      );
    case "reasoning":
      return <p className="reasoning">{entry.text}</p>;
    case "tool":
      return (
        <details className={`tool ${entry.status.replace(" ", "-")}`}>
          <summary>
            <span className="tool-status">{toolMark(entry.status)}</span>
            <span className="tool-name">{entry.name}</span>
            <span className="tool-args">{argsPreview(entry.args)}</span>
          </summary>
          <pre className="tool-io">{prettyArgs(entry.args)}</pre>
          {entry.output !== undefined && <pre className="tool-io output">{entry.output}</pre>}
        </details>
      );
    case "attention":
      return (
        <div className={`bubble attention-entry ${entry.type}`}>
          <span className="who">
            {entry.type === "approval" ? t("who.approval") : t("who.question")}
          </span>
          <p>{entry.prompt}</p>
          {entry.resolved && (
            <p className="resolution">
              {entry.resolved.approved === true && `${t("resolution.approved")} `}
              {entry.resolved.approved === false && `${t("resolution.denied")} `}
              {entry.resolved.response}
            </p>
          )}
        </div>
      );
    case "notice":
      return <p className={`notice ${entry.tone}`}>{noticeText(t, entry.notice)}</p>;
  }
}

function noticeText(t: Translate, notice: Notice): string {
  switch (notice.type) {
    case "retryable":
    case "fatal":
    case "context_overflow":
      return t(`notice.${notice.type}`, { message: notice.message });
    case "paused":
      return t("notice.paused", { reason: notice.reason });
    case "resumed":
      return t("notice.resumed");
    default: {
      const heading = t(`notice.${notice.type}`);
      return notice.summary ? `${heading}\n${notice.summary}` : heading;
    }
  }
}

function toolMark(status: ToolStatus) {
  switch (status) {
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "denied":
      return "⊘";
    case "interrupted":
      return "↯";
    case "running":
      return "…";
    case "awaiting approval":
      return "?";
    default:
      return "·";
  }
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function Composer({ task }: { task: TaskView }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => api.send(task.id, text),
    onSuccess: () => setText(""),
  });
  if (task.status === "ended") {
    return <p className="muted composer-closed">{t("composer.ended")}</p>;
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send.mutate();
      }}
    >
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
        }}
        placeholder={task.status === "idle" ? t("composer.reply") : t("composer.add")}
      />
      <button type="submit" className="primary" disabled={!text.trim() || send.isPending}>
        {t("composer.send")}
      </button>
      {send.error && <span className="error">{send.error.message}</span>}
    </form>
  );
}

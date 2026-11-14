import type { TaskEndOutcome, TaskStatus, TaskSummary } from "@warren/protocol";
import { type RefObject, useMemo } from "react";
import { useI18n } from "../context.tsx";
import { formatAgo, type MessageKey, statusLabel } from "../i18n.ts";
import {
  Alert,
  Check,
  Clock,
  Close,
  Gear,
  Inbox,
  Logo,
  Message,
  Pause,
  Plug,
  Plus,
  Search,
  Shield,
  Sparkle,
  Trash,
} from "../icons.tsx";
import { displayTitle, groupTasks } from "../model.ts";

const GROUPS: { key: keyof ReturnType<typeof groupTasks>; label: MessageKey }[] = [
  { key: "needsYou", label: "group.needsYou" },
  { key: "working", label: "group.working" },
  { key: "idle", label: "group.idle" },
  { key: "paused", label: "group.paused" },
  { key: "ended", label: "group.ended" },
];

export function Sidebar(props: {
  tasks: TaskSummary[] | undefined;
  loading: boolean;
  unreachable: boolean;
  selected: string | null;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  sandbox: string | undefined;
  onQuery(query: string): void;
  onSelect(id: string): void;
  onNew(): void;
  onDelete(task: TaskSummary): void;
  onTriggers(): void;
  onSettings(): void;
  onAutomations(): void;
  onSkills(): void;
  onMcp(): void;
  page: "tasks" | "triggers" | "settings" | "automations" | "skills" | "mcp";
}) {
  const { t } = useI18n();
  const filtered = useMemo(() => {
    const query = props.query.trim().toLowerCase();
    if (!query || !props.tasks) return props.tasks ?? [];
    return props.tasks.filter((task) =>
      `${task.title} ${task.repo ?? ""}`.toLowerCase().includes(query),
    );
  }, [props.tasks, props.query]);
  const groups = useMemo(() => groupTasks(filtered), [filtered]);
  const now = Date.now();

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="brand">
          <Logo size={22} />
          Warren
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={props.onNew}
          title={`${t("app.newTask")} (⌘N)`}
        >
          <Plus />
        </button>
      </header>

      <label className="search">
        <Search size={15} />
        <input
          ref={props.searchRef}
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder={t("app.search")}
          spellCheck={false}
        />
        <kbd>⌘K</kbd>
      </label>

      <nav className="side-nav">
        {(
          [
            ["automations", Clock, "nav.automations", props.onAutomations],
            ["skills", Sparkle, "nav.skills", props.onSkills],
            ["mcp", Plug, "nav.mcp", props.onMcp],
          ] as const
        ).map(([page, Icon, label, onClick]) => (
          <button
            key={page}
            type="button"
            className={`side-link ${props.page === page ? "on" : ""}`}
            onClick={onClick}
          >
            <Icon size={15} className="side-icon" />
            {t(label)}
          </button>
        ))}
      </nav>

      <nav className="inbox">
        {props.loading && <p className="sidebar-note">{t("app.loading")}</p>}
        {props.unreachable && <p className="sidebar-note error">{t("app.unreachable")}</p>}
        {props.tasks && filtered.length === 0 && props.query && (
          <p className="sidebar-note">{t("search.none")}</p>
        )}
        {GROUPS.map(({ key, label }) =>
          groups[key].length === 0 ? null : (
            <section key={key} className={`group group-${key}`}>
              <h3>
                {t(label)}
                <span className="count">{groups[key].length}</span>
              </h3>
              <ul>
                {groups[key].slice(0, key === "ended" ? 40 : undefined).map((task) => (
                  <li key={task.id} className="task-item">
                    <button
                      type="button"
                      className={`task-row ${props.selected === task.id ? "selected" : ""}`}
                      onClick={() => props.onSelect(task.id)}
                    >
                      <StatusIcon status={task.status} outcome={task.outcome} />
                      <span className="row-body">
                        <span className="row-title">{displayTitle(task.title, task.repo)}</span>
                        {task.attention?.[0] && (
                          <span className="row-attention">
                            <span className="tag warning">
                              {task.attention[0].kind === "approval"
                                ? t("row.approve")
                                : t("row.asks")}
                            </span>
                            {task.attention[0].prompt}
                          </span>
                        )}
                        <span className="row-meta">
                          {task.repo && <span className="repo">{task.repo}</span>}
                          <span>{formatAgo(t, now - task.updatedAt)}</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="row-delete"
                      title={t("delete.action")}
                      aria-label={t("delete.action")}
                      onClick={() => props.onDelete(task)}
                    >
                      <Trash size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </nav>

      <footer className="sidebar-foot">
        <button
          type="button"
          className={`foot-link ${props.page === "settings" ? "on" : ""}`}
          onClick={props.onSettings}
          title={`${t("app.settings")} (⌘,)`}
        >
          <Gear size={14} />
          {t("app.settings")}
        </button>
        <button
          type="button"
          className={`foot-link ${props.page === "triggers" ? "on" : ""}`}
          onClick={props.onTriggers}
        >
          <Inbox size={14} />
          {t("triggers.open")}
        </button>
        {props.sandbox && (
          <span
            className={`sandbox ${props.sandbox === "none" ? "off" : ""}`}
            title={props.sandbox === "none" ? t("app.noSandbox") : t("app.sandbox")}
          >
            <Shield size={14} />
          </span>
        )}
      </footer>
    </aside>
  );
}

/** A task's state at a glance: a spinning ring while it works, a mark otherwise. */
export function StatusIcon(props: {
  status: TaskStatus;
  outcome?: TaskEndOutcome | undefined;
  size?: number;
}) {
  const { t } = useI18n();
  const { status, outcome, size = 16 } = props;
  const inner = size - 6;
  const tone = status === "ended" ? (outcome ?? "completed") : status;
  const mark =
    status === "active" ? null : status === "waiting" ? (
      <Alert size={inner} />
    ) : status === "paused" ? (
      <Pause size={inner} />
    ) : status === "idle" ? (
      <Message size={inner} />
    ) : outcome === "failed" || outcome === "cancelled" ? (
      <Close size={inner} />
    ) : (
      <Check size={inner} />
    );
  const label = status === "ended" && outcome ? t(`outcome.${outcome}`) : statusLabel(t, status);
  return (
    <span className={`status-icon ${tone}`} style={{ width: size, height: size }} title={label}>
      {mark}
    </span>
  );
}

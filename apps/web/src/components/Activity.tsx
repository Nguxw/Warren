import { type ReactNode, useState } from "react";
import { useI18n } from "../context.tsx";
import { type Translate, toolStatusLabel } from "../i18n.ts";
import {
  Alert,
  Check,
  ChevronRight,
  Close,
  Eye,
  Pencil,
  Sparkle,
  Terminal,
  Upload,
} from "../icons.tsx";
import {
  activity,
  argsPreview,
  type Block,
  categoryOf,
  type KeyedEntry,
  type Notice,
  type StepCategory,
  type ToolEntry,
} from "../model.ts";

const CATEGORY_ICON: Record<StepCategory, (p: { size?: number }) => ReactNode> = {
  inspect: Eye,
  edit: Pencil,
  run: Terminal,
  publish: Upload,
  other: Sparkle,
};
const ORDER: StepCategory[] = ["inspect", "edit", "run", "publish", "other"];

export function Activity({ entries }: { entries: KeyedEntry[] }) {
  return (
    <ol className="activity">
      {activity(entries).map((block) => (
        <li
          key={block.key}
          className={`block block-${block.kind === "steps" ? "steps" : block.entry.kind}`}
        >
          {block.kind === "steps" ? <Steps block={block} /> : <EntryView entry={block.entry} />}
        </li>
      ))}
    </ol>
  );
}

function Steps({ block }: { block: Extract<Block, { kind: "steps" }> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const parts = ORDER.filter((c) => block.counts[c]).map((category) => {
    const Icon = CATEGORY_ICON[category];
    return (
      <span key={category} className="step-count">
        <Icon size={14} />
        {t(`steps.${category}`, { n: block.counts[category] ?? 0 })}
      </span>
    );
  });
  return (
    <div className={`steps ${open ? "open" : ""}`}>
      <button type="button" className="steps-summary" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="chevron" />
        <span className="step-counts">{parts}</span>
        {block.failed > 0 && (
          <span className="tag danger">{t("steps.failed", { n: block.failed })}</span>
        )}
        {block.active && <span className="spinner" role="status" aria-label={t("steps.running")} />}
      </button>
      {open && (
        <ul className="tool-list">
          {block.tools.map((tool) => (
            <li key={tool.key}>
              <ToolRow tool={tool} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const { t } = useI18n();
  const Icon = CATEGORY_ICON[categoryOf(tool.name)];
  const bad = tool.status === "error" || tool.status === "denied" || tool.status === "interrupted";
  const busy = tool.status === "running" || tool.status === "pending";
  return (
    <details className={`tool ${bad ? "bad" : ""}`}>
      <summary title={toolStatusLabel(t, tool.status)}>
        <Icon size={14} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-args">{argsPreview(tool.args)}</span>
        <span className="tool-state">
          {busy ? (
            <span className="spinner small" />
          ) : bad ? (
            <Close size={14} />
          ) : tool.status === "awaiting approval" ? (
            <Alert size={14} />
          ) : (
            <Check size={14} />
          )}
        </span>
      </summary>
      <div className="tool-detail">
        <span className="detail-label">{t("tool.arguments")}</span>
        <pre>{prettyArgs(tool.args)}</pre>
        {tool.output !== undefined && (
          <>
            <span className="detail-label">
              {t("tool.output")} · {toolStatusLabel(t, tool.status)}
            </span>
            <pre>{tool.output}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function EntryView({ entry }: { entry: KeyedEntry }): ReactNode {
  const { t } = useI18n();
  const time = new Date(entry.at).toLocaleTimeString();
  switch (entry.kind) {
    case "instruction":
      return (
        <figure className="instruction" title={time}>
          <figcaption>{t("who.task")}</figcaption>
          <p>{entry.text}</p>
        </figure>
      );
    case "user":
      return (
        <div className="message from-user" title={time}>
          <p>{entry.text}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="message from-warren" title={time}>
          <p>{entry.text}</p>
        </div>
      );
    case "reasoning":
      return <p className="reasoning">{entry.text}</p>;
    case "attention":
      return (
        <div className={`asked ${entry.type}`}>
          <span className="asked-label">
            {entry.type === "approval" ? t("who.approval") : t("who.question")}
          </span>
          <p className="asked-prompt">{entry.prompt}</p>
          <p className="asked-answer">
            {entry.resolved ? (
              <>
                {entry.resolved.approved === true && (
                  <span className="tag success">{t("resolution.approved")}</span>
                )}
                {entry.resolved.approved === false && (
                  <span className="tag danger">{t("resolution.denied")}</span>
                )}
                {entry.resolved.response}
              </>
            ) : (
              <span className="tag warning">{t("resolution.waiting")}</span>
            )}
          </p>
        </div>
      );
    case "notice": {
      const { notice } = entry;
      // The ending is shown in full in the status card; here it only marks the place.
      if (notice.type === "completed" || notice.type === "failed" || notice.type === "cancelled") {
        return (
          <p className={`ended-divider ${entry.tone}`}>
            <span>{t(`notice.${notice.type}`)}</span>
          </p>
        );
      }
      return <p className={`notice ${entry.tone}`}>{noticeText(t, notice)}</p>;
    }
    case "tool":
      return <ToolRow tool={entry} />;
  }
}

export function noticeText(t: Translate, notice: Notice): string {
  switch (notice.type) {
    case "retryable":
    case "recovered":
    case "fatal":
    case "context_overflow":
      return t(`notice.${notice.type}`, { message: notice.message });
    case "paused":
      return t("notice.paused", { reason: notice.reason });
    case "resumed":
      return t("notice.resumed");
    case "compacted":
      return t("notice.compacted", { n: notice.replaces });
    case "exported":
      return t("notice.exported", { n: notice.files, destination: notice.destination });
    default: {
      const heading = t(`notice.${notice.type}`);
      return notice.summary ? `${heading}\n${notice.summary}` : heading;
    }
  }
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

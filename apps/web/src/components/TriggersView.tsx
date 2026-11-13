import { useQuery } from "@tanstack/react-query";
import type { TriggerRecord } from "@warren/protocol";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { formatAgo } from "../i18n.ts";
import { shortId } from "../model.ts";

/**
 * Everything connectors brought in and what routing decided. In Observe mode this is how a rule
 * earns trust: read what Warren would have started, then switch the rule to auto.
 */
export function TriggersView({ onOpenTask }: { onOpenTask(id: string): void }) {
  const { t } = useI18n();
  const triggers = useQuery({
    queryKey: ["triggers"],
    queryFn: api.triggers,
    refetchInterval: 10_000,
  });
  const list = triggers.data ?? [];
  const counts = list.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision.action] = (acc[r.decision.action] ?? 0) + 1;
    return acc;
  }, {});
  const now = Date.now();

  return (
    <article className="task-view triggers-view">
      <header className="task-head">
        <div className="task-title">
          <h1>{t("triggers.title")}</h1>
        </div>
        <p className="triggers-intro">{t("triggers.intro")}</p>
        {list.length > 0 && (
          <p className="task-meta triggers-counts">
            {(["create", "observe", "append", "answer", "ignore"] as const).map((action) =>
              counts[action] ? (
                <span key={action} className={`decision ${action}`}>
                  {t(`decision.${action}`)} {counts[action]}
                </span>
              ) : null,
            )}
          </p>
        )}
      </header>

      {triggers.isLoading && <p className="empty-note">{t("app.loading")}</p>}
      {!triggers.isLoading && list.length === 0 && (
        <p className="empty-note">{t("triggers.none")}</p>
      )}

      <ol className="trigger-list">
        {list.map((record) => (
          <li key={record.id} className={`trigger decision-${record.decision.action}`}>
            <span className={`decision ${record.decision.action}`}>
              {t(`decision.${record.decision.action}`)}
            </span>
            <div className="trigger-body">
              <p className="trigger-line">
                <a href={record.event.url} target="_blank" rel="noreferrer">
                  {record.event.thread.replace(/^github:/, "")}
                </a>
                <span className="muted">
                  {record.event.actor ? `@${record.event.actor}` : t(`kind.${record.event.kind}`)}
                </span>
                <span className="muted">{formatAgo(t, now - record.receivedAt)}</span>
              </p>
              <p className="trigger-detail">{detail(record)}</p>
            </div>
            {record.taskId && (
              <button
                type="button"
                className="chip"
                onClick={() => onOpenTask(record.taskId as string)}
              >
                {shortId(record.taskId)}
              </button>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

function detail(record: TriggerRecord): string {
  const { decision, event } = record;
  switch (decision.action) {
    case "create":
    case "observe":
      return decision.title;
    case "append":
    case "answer":
      return decision.text;
    case "ignore":
      return `${decision.reason}${event.body ? ` · ${event.body.slice(0, 120)}` : ""}`;
  }
}

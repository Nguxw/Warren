import { useMemo } from "react";
import type { WorkspaceDiff } from "../api.ts";
import { useI18n } from "../context.tsx";
import { FileIcon } from "../icons.tsx";
import { type DiffFile, parseDiff } from "../model.ts";

/** The task's changes, for review: a file list and a diff per file. */
export function Changes(props: {
  diff: WorkspaceDiff | undefined;
  loading: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();
  const files = useMemo(() => (props.diff ? parseDiff(props.diff.patch) : []), [props.diff]);
  if (props.error)
    return <p className="empty-note">{t("changes.error", { error: props.error.message })}</p>;
  if (props.loading || !props.diff) return <p className="empty-note">{t("changes.loading")}</p>;
  if (files.length === 0) return <p className="empty-note">{t("changes.none")}</p>;

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="changes">
      <p className="changes-summary">
        {t("changes.summary", { files: files.length })}
        <span className="plus">+{additions}</span>
        <span className="minus">−{deletions}</span>
      </p>
      {props.diff.truncated && <p className="notice warn">{t("changes.truncated")}</p>}
      {files.map((file) => (
        <FileDiff key={file.path} file={file} defaultOpen={files.length <= 6} />
      ))}
    </div>
  );
}

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const { t } = useI18n();
  return (
    <details className="file-diff" open={defaultOpen}>
      <summary>
        <FileIcon size={14} />
        <span className="file-path">{file.path}</span>
        {file.status !== "modified" && (
          <span className={`tag ${file.status === "deleted" ? "danger" : "success"}`}>
            {t(`changes.status.${file.status}`)}
          </span>
        )}
        <span className="file-stats">
          <span className="plus">+{file.additions}</span>
          <span className="minus">−{file.deletions}</span>
        </span>
      </summary>
      {file.binary ? (
        <p className="empty-note">{t("changes.binary")}</p>
      ) : (
        <div className="diff-scroll">
          <table className="diff">
            <tbody>
              {file.lines.map((line) =>
                line.kind === "hunk" ? (
                  <tr key={`hunk:${line.text}`} className="hunk">
                    <td colSpan={3}>{line.text}</td>
                  </tr>
                ) : (
                  <tr
                    key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}`}
                    className={line.kind}
                  >
                    <td className="ln">{line.oldLine ?? ""}</td>
                    <td className="ln">{line.newLine ?? ""}</td>
                    <td className="code">
                      <span className="sign">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

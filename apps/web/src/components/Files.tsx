import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type ArtifactContent, type ArtifactFile, type ArtifactList, api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { formatAgo } from "../i18n.ts";
import { Check, Copy, FileIcon, Folder, Reveal } from "../icons.tsx";
import { formatBytes, groupFiles, previewKind } from "../model.ts";
import { Markdown } from "./Markdown.tsx";

/** What the task produced: its workspace's files, and a preview of the one picked. */
export function Files(props: {
  taskId: string;
  /** For a copied folder: the original, so the list reads as changes to it. */
  source?: string | undefined;
  list: ArtifactList | undefined;
  loading: boolean;
  error: Error | null;
  selected: string | undefined;
  onSelect(path: string): void;
}) {
  const { t } = useI18n();
  const { list } = props;
  if (props.error)
    return <p className="empty-note">{t("files.error", { error: props.error.message })}</p>;
  if (props.loading || !list) return <p className="empty-note">{t("files.loading")}</p>;

  const groups = groupFiles(list.files);
  const selected =
    list.files.find((f) => f.path === props.selected) ?? groups.top[0] ?? list.files[0];
  const row = (file: ArtifactFile, name: string) => (
    <li key={file.path}>
      <FileRow
        file={file}
        name={name}
        selected={file.path === selected?.path}
        onSelect={() => props.onSelect(file.path)}
      />
    </li>
  );
  return (
    <div className="files">
      <Location taskId={props.taskId} root={list.root} />
      {props.source && (
        <p className="copy-summary">
          {t("files.copySummary", { source: props.source, unchanged: list.unchanged ?? 0 })}
          {(list.deleted?.length ?? 0) > 0 && (
            <span className="minus">
              {" · "}
              {t("files.deleted", {
                n: list.deleted?.length ?? 0,
                files: (list.deleted ?? []).slice(0, 5).join(", "),
              })}
            </span>
          )}
        </p>
      )}
      {list.files.length === 0 ? (
        <p className="empty-note">{props.source ? t("files.noChanges") : t("files.none")}</p>
      ) : (
        <div className="files-split">
          <ul className="file-list">
            {groups.top.map((file) => row(file, file.path))}
            {groups.folders.map((folder) => (
              <li key={folder.name}>
                <details
                  className="file-folder"
                  open={groups.top.length === 0 || selected?.path.startsWith(`${folder.name}/`)}
                >
                  <summary>
                    <Folder size={14} />
                    <span className="file-name">{folder.name}</span>
                    <span className="count">{folder.files.length}</span>
                  </summary>
                  <ul>
                    {folder.files.map((file) => row(file, file.path.slice(folder.name.length + 1)))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          {selected ? (
            <Preview
              key={`${selected.path}:${selected.modifiedAt}`}
              taskId={props.taskId}
              path={selected.path}
              modifiedAt={selected.modifiedAt}
              onFile={props.onSelect}
            />
          ) : (
            <p className="empty-note">{t("files.select")}</p>
          )}
        </div>
      )}
      {list.truncated && <p className="notice warn">{t("files.truncated")}</p>}
    </div>
  );
}

function FileRow(props: { file: ArtifactFile; name: string; selected: boolean; onSelect(): void }) {
  const { t } = useI18n();
  const { file } = props;
  return (
    <button
      type="button"
      className={`file-row ${props.selected ? "selected" : ""}`}
      onClick={props.onSelect}
      title={file.path}
    >
      <FileIcon size={14} />
      <span className="file-name">
        {props.name}
        {file.status && (
          <span className={`tag ${file.status === "added" ? "success" : "warning"}`}>
            {t(`files.${file.status}`)}
          </span>
        )}
      </span>
      <span className="file-meta">
        {formatBytes(file.size)} · {formatAgo(t, Date.now() - file.modifiedAt)}
      </span>
    </button>
  );
}

/** Where the files are on disk, with the two things a person does with that: copy, reveal. */
export function Location(props: { taskId: string; root: string; path?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const reveal = useMutation({
    mutationFn: () => api.reveal(props.taskId, props.path ? { path: props.path } : undefined),
  });
  const full = props.path ? `${props.root}/${props.path}` : props.root;
  return (
    <div className="location">
      <Folder size={14} />
      <span className="location-label">{t("files.location")}</span>
      <code title={full}>{full}</code>
      <button
        type="button"
        className="button ghost small"
        onClick={() => {
          navigator.clipboard
            ?.writeText(full)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? t("files.copied") : t("files.copyPath")}
      </button>
      <button type="button" className="button small" onClick={() => reveal.mutate()}>
        <Reveal size={14} />
        {t("files.reveal")}
      </button>
      {reveal.error && <p className="form-error">{reveal.error.message}</p>}
    </div>
  );
}

function Preview(props: {
  taskId: string;
  path: string;
  modifiedAt: number;
  onFile(path: string): void;
}) {
  const { t } = useI18n();
  const file = useQuery({
    queryKey: ["file", props.taskId, props.path, props.modifiedAt],
    queryFn: () => api.file(props.taskId, props.path),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [source, setSource] = useState(false);
  const content = file.data;

  return (
    <section className="preview">
      <header className="preview-head">
        <span className="preview-name">{props.path}</span>
        {content?.kind === "text" && previewKind(props.path) === "markdown" && (
          <div className="segmented small">
            {([false, true] as const).map((value) => (
              <label key={String(value)} className={source === value ? "on" : ""}>
                <input
                  type="radio"
                  name="preview-mode"
                  checked={source === value}
                  onChange={() => setSource(value)}
                />
                {value ? t("files.source") : t("files.rendered")}
              </label>
            ))}
          </div>
        )}
      </header>
      {file.error ? (
        <p className="empty-note">{t("files.error", { error: file.error.message })}</p>
      ) : !content ? (
        <p className="empty-note">{t("files.loading")}</p>
      ) : (
        <PreviewBody content={content} source={source} onFile={props.onFile} />
      )}
    </section>
  );
}

function PreviewBody({
  content,
  source,
  onFile,
}: {
  content: ArtifactContent;
  source: boolean;
  onFile(path: string): void;
}) {
  const { t } = useI18n();
  if (content.kind === "image") {
    return (
      <div className="preview-image">
        <img src={`data:${content.mime};base64,${content.base64}`} alt={content.path} />
      </div>
    );
  }
  if (content.kind === "binary") {
    return <p className="empty-note">{t("files.binary", { size: formatBytes(content.size) })}</p>;
  }
  const kind = previewKind(content.path);
  return (
    <>
      {content.truncated && <p className="notice warn">{t("files.textTruncated")}</p>}
      {kind === "html" && <p className="notice info">{t("files.htmlNote")}</p>}
      {kind === "markdown" && !source ? (
        <Markdown
          variant="document"
          onFile={onFile}
          base={content.path.split("/").slice(0, -1).join("/")}
        >
          {content.text}
        </Markdown>
      ) : (
        <pre className="preview-text">{content.text}</pre>
      )}
    </>
  );
}

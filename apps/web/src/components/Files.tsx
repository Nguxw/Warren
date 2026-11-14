import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type ArtifactContent, type ArtifactFile, type ArtifactList, api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { formatAgo } from "../i18n.ts";
import { Check, ChevronDown, Copy, FileIcon, Folder, Reveal } from "../icons.tsx";
import { formatBytes, groupFiles, previewKind } from "../model.ts";
import { Markdown } from "./Markdown.tsx";
import { Menu } from "./Menu.tsx";

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
  return (
    <div className="files">
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
      {!selected ? (
        <>
          <p className="empty-note">{props.source ? t("files.noChanges") : t("files.none")}</p>
          <Location taskId={props.taskId} root={list.root} />
        </>
      ) : (
        <Preview
          key={`${selected.path}:${selected.modifiedAt}`}
          taskId={props.taskId}
          root={list.root}
          file={selected}
          picker={
            <FilePicker
              groups={groups}
              count={list.files.length}
              selected={selected}
              onSelect={props.onSelect}
            />
          }
          onFile={props.onSelect}
        />
      )}
      {list.truncated && <p className="notice warn">{t("files.truncated")}</p>}
    </div>
  );
}

/**
 * The file shown, and with more than one file a menu of the others: the main ones first, then
 * each folder's. Keeps the preview at full width instead of a list column beside it.
 */
function FilePicker(props: {
  groups: ReturnType<typeof groupFiles<ArtifactFile>>;
  count: number;
  selected: ArtifactFile;
  onSelect(path: string): void;
}) {
  const { t } = useI18n();
  const name = props.selected.path.split("/").at(-1) ?? props.selected.path;
  const label = (
    <>
      <FileIcon size={14} />
      <span className="picker-name">{name}</span>
      {props.selected.status && <StatusTag status={props.selected.status} />}
    </>
  );
  if (props.count === 1) {
    return (
      <span className="file-picker single" title={props.selected.path}>
        {label}
      </span>
    );
  }
  const option = (file: ArtifactFile, shown: string, close: () => void) => (
    <button
      key={file.path}
      type="button"
      className={`menu-item file-option ${file.path === props.selected.path ? "on" : ""}`}
      title={file.path}
      onClick={() => {
        props.onSelect(file.path);
        close();
      }}
    >
      <FileIcon size={14} />
      <span className="menu-item-main">
        <span className="file-option-name">
          {shown}
          {file.status && <StatusTag status={file.status} />}
        </span>
        <span className="file-option-meta">
          {formatBytes(file.size)} · {formatAgo(t, Date.now() - file.modifiedAt)}
        </span>
      </span>
      {file.path === props.selected.path && <Check size={14} />}
    </button>
  );
  return (
    <Menu
      className="file-picker"
      placement="below"
      active={false}
      title={props.selected.path}
      trigger={
        <>
          {label}
          <span className="picker-count">{t("files.of", { n: props.count })}</span>
          <ChevronDown size={13} />
        </>
      }
    >
      {(close) => (
        <div className="file-menu">
          {props.groups.top.map((file) => option(file, file.path, close))}
          {props.groups.folders.map((folder) => (
            <div key={folder.name} className="file-menu-group">
              <p className="file-menu-folder">
                <Folder size={13} />
                {folder.name}
                <span>{folder.files.length}</span>
              </p>
              {folder.files.map((file) =>
                option(file, file.path.slice(folder.name.length + 1), close),
              )}
            </div>
          ))}
        </div>
      )}
    </Menu>
  );
}

function StatusTag({ status }: { status: "added" | "modified" }) {
  const { t } = useI18n();
  return (
    <span className={`tag ${status === "added" ? "success" : "warning"}`}>
      {t(`files.${status}`)}
    </span>
  );
}

/** Copies a path; the button says so for a moment. */
function CopyPath({ path, label }: { path: string; label?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={label ? "button ghost small" : "icon-button"}
      title={`${t("files.copyPath")}: ${path}`}
      onClick={() => {
        navigator.clipboard
          ?.writeText(path)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {label && (copied ? t("files.copied") : t("files.copyPath"))}
    </button>
  );
}

/** Where the files are on disk, with the two things a person does with that: copy, reveal. */
export function Location(props: { taskId: string; root: string; path?: string }) {
  const { t } = useI18n();
  const reveal = useMutation({
    mutationFn: () => api.reveal(props.taskId, props.path ? { path: props.path } : undefined),
  });
  const full = props.path ? `${props.root}/${props.path}` : props.root;
  return (
    <div className="location">
      <Folder size={14} />
      <span className="location-label">{t("files.location")}</span>
      <code title={full}>{full}</code>
      <CopyPath path={full} label />
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
  root: string;
  file: ArtifactFile;
  picker: ReactNode;
  onFile(path: string): void;
}) {
  const { t } = useI18n();
  const { path, modifiedAt } = props.file;
  const reveal = useMutation({ mutationFn: () => api.reveal(props.taskId, { path }) });
  const file = useQuery({
    queryKey: ["file", props.taskId, path, modifiedAt],
    queryFn: () => api.file(props.taskId, path),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [source, setSource] = useState(false);
  const content = file.data;

  return (
    <section className="preview">
      <header className="preview-head">
        {props.picker}
        <div className="preview-actions">
          {content?.kind === "text" && previewKind(path) === "markdown" && (
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
          <CopyPath path={`${props.root}/${path}`} />
          <button
            type="button"
            className="icon-button"
            title={reveal.error?.message ?? t("files.reveal")}
            onClick={() => reveal.mutate()}
          >
            <Reveal size={15} />
          </button>
        </div>
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

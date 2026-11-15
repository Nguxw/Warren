import { type FilePart, MAX_UPLOAD_BYTES, type Upload } from "@warren/protocol";
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, attachmentUrl } from "../api.ts";
import { useI18n } from "../context.tsx";
import { Close, FileIcon, Paperclip } from "../icons.tsx";
import { formatBytes } from "../model.ts";

/**
 * Attaching files to a task or a message: picked, dropped or pasted. Each file uploads as soon
 * as it is added, so sending only names the uploads; a file removed before sending is deleted
 * from the daemon again.
 */

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** A local preview for images the browser can show. */
  preview?: string;
  upload?: Upload;
  /** Why it cannot be attached; `tooBig` is worded by the interface. */
  error?: string;
}

const PREVIEWABLE = /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/;

export function useAttachments() {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const removed = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(files);
  current.current = files;
  // Previews are object URLs; they are released with the composer.
  useEffect(
    () => () => {
      for (const file of current.current) if (file.preview) URL.revokeObjectURL(file.preview);
    },
    [],
  );

  const add = useCallback((list: Iterable<File>) => {
    for (const file of list) {
      const key = crypto.randomUUID();
      const preview = PREVIEWABLE.test(file.type) ? URL.createObjectURL(file) : undefined;
      const tooBig = file.size > MAX_UPLOAD_BYTES;
      setFiles((all) => [
        ...all,
        {
          key,
          name: file.name,
          size: file.size,
          ...(preview && { preview }),
          ...(tooBig && { error: "tooBig" }),
        },
      ]);
      if (tooBig) continue;
      const settle = (patch: Partial<PendingFile>) =>
        setFiles((all) => all.map((f) => (f.key === key ? { ...f, ...patch } : f)));
      api.upload(file).then(
        (upload) => {
          if (removed.current.has(key)) api.discardUpload(upload.id).catch(() => {});
          else settle({ upload, name: upload.name });
        },
        (error: Error) => settle({ error: error.message }),
      );
    }
  }, []);

  const remove = useCallback((key: string) => {
    removed.current.add(key);
    const file = current.current.find((f) => f.key === key);
    if (file?.upload) api.discardUpload(file.upload.id).catch(() => {});
    if (file?.preview) URL.revokeObjectURL(file.preview);
    setFiles((all) => all.filter((f) => f.key !== key));
  }, []);

  /** After sending: the uploads now belong to the task. */
  const clear = useCallback(() => {
    for (const file of current.current) if (file.preview) URL.revokeObjectURL(file.preview);
    setFiles([]);
  }, []);

  /** Takes files pasted into the text box, such as a screenshot; pasted text stays text. */
  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      const pasted = [...event.clipboardData.files];
      if (pasted.length === 0) return;
      if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
      add(pasted);
    },
    [add],
  );

  return {
    files,
    add,
    remove,
    clear,
    onPaste,
    /** Ids to send; only files that finished uploading. */
    ids: files.flatMap((f) => (f.upload ? [f.upload.id] : [])),
    /** Whether sending should wait: a file is still uploading. */
    busy: files.some((f) => !f.upload && !f.error),
    /** Opens the system's file picker. */
    pick: () => input.current?.click(),
    picker: (
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add([...e.target.files]);
          e.target.value = "";
        }}
      />
    ),
  };
}

/** Lets files be dropped anywhere on a composer, which shows that it will take them. */
export function useDropZone(add: (files: Iterable<File>) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return {
    over,
    props: {
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (carriesFiles(event)) event.preventDefault();
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        add([...event.dataTransfer.files]);
      },
    },
  };
}

export function AttachButton(props: { onClick(): void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="bar-button plus"
      title={t("attach.add")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      <Paperclip size={15} />
    </button>
  );
}

/** The files waiting to go with the text being written. */
export function PendingFiles(props: { files: PendingFile[]; onRemove(key: string): void }) {
  const { t } = useI18n();
  if (props.files.length === 0) return null;
  return (
    <div className="file-tray">
      {props.files.map((file) => {
        const state = file.error ? "failed" : file.upload ? "ready" : "busy";
        const error = file.error === "tooBig" ? t("attach.tooBig") : file.error;
        return (
          <div key={file.key} className={`file-chip ${state}`} title={error ?? file.name}>
            <FileThumb preview={file.preview} />
            <span className="file-chip-text">
              <span className="file-chip-name">{file.name}</span>
              <span className={`file-chip-meta ${error ? "error" : ""}`}>
                {error ??
                  (state === "busy"
                    ? t("attach.uploading")
                    : formatBytes(file.upload?.size ?? file.size))}
              </span>
            </span>
            <button
              type="button"
              title={t("attach.remove")}
              onClick={() => props.onRemove(file.key)}
            >
              <Close size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function FileThumb({ preview }: { preview: string | undefined }) {
  return preview ? (
    <img className="file-chip-thumb" src={preview} alt="" />
  ) : (
    <span className="file-chip-thumb icon">
      <FileIcon size={16} />
    </span>
  );
}

const SHOWN = /^image\/(png|jpeg|gif|webp)$/;

/** Files a message carried, in the timeline: images as pictures, other files as chips. */
export function MessageFiles(props: { taskId: string; files: readonly FilePart[] }) {
  const [open, setOpen] = useState<FilePart>();
  if (props.files.length === 0) return null;
  const images = props.files.filter((f) => SHOWN.test(f.mediaType));
  const others = props.files.filter((f) => !SHOWN.test(f.mediaType));
  return (
    <div className="message-files">
      {images.length > 0 && (
        <div className="message-images">
          {images.map((file) => (
            <button key={file.name} type="button" title={file.name} onClick={() => setOpen(file)}>
              <img src={attachmentUrl(props.taskId, file.name)} alt={file.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {others.map((file) => (
        <a
          key={file.name}
          className="file-chip ready"
          href={attachmentUrl(props.taskId, file.name)}
          target="_blank"
          rel="noreferrer"
          title={file.name}
        >
          <FileThumb preview={undefined} />
          <span className="file-chip-text">
            <span className="file-chip-name">{file.name}</span>
            <span className="file-chip-meta">{formatBytes(file.size)}</span>
          </span>
        </a>
      ))}
      {open && (
        <Lightbox onClose={() => setOpen(undefined)}>
          <img src={attachmentUrl(props.taskId, open.name)} alt={open.name} />
          <p>{open.name}</p>
        </Lightbox>
      )}
    </div>
  );
}

function Lightbox(props: { onClose(): void; children: ReactNode }) {
  const { t } = useI18n();
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay lightbox" role="dialog" aria-modal="true">
      <button type="button" className="backdrop" aria-label={t("attach.close")} onClick={onClose} />
      <figure className="lightbox-body">{props.children}</figure>
    </div>
  );
}

/** A composer's notice while files are dragged over it. */
export function DropHint() {
  const { t } = useI18n();
  return (
    <div className="drop-hint">
      <Paperclip size={18} />
      {t("attach.drop")}
    </div>
  );
}

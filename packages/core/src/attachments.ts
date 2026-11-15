import type { ContentPart, ConversationItem, FilePart } from "@warren/protocol";

/**
 * Attached files as a model sees them.
 *
 * The log keeps a reference to each file; just before a model call its bytes are read from disk
 * and each file becomes what this model can take in: an image or a PDF goes to the model itself
 * if it accepts that kind, a small text file is written into the message, and anything else is
 * named with its path so the model can open it with its tools. The person's files are also
 * copied to `attachments/` in the task's scratch directory, where those paths point.
 */

/** Kinds of file, besides text, that a model may take in directly. */
export type FileInput = "image" | "pdf";

/** Image formats every provider accepts as they are; others are converted when uploaded. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The smallest per-image limit among providers (Anthropic). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Text files up to this size are written into the message. */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;

export function isTextType(mediaType: string): boolean {
  const type = mediaType.split(";")[0]?.trim() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** How a file can reach a model, or undefined when only its path can. */
export function fileKind(file: FilePart): FileInput | "text" | undefined {
  if (IMAGE_TYPES.has(file.mediaType)) return file.size <= MAX_IMAGE_BYTES ? "image" : undefined;
  if (file.mediaType === "application/pdf") return file.size <= MAX_PDF_BYTES ? "pdf" : undefined;
  if (isTextType(file.mediaType)) return file.size <= MAX_INLINE_TEXT_BYTES ? "text" : undefined;
  return undefined;
}

/** Where the model finds a file, relative to its scratch directory. */
export function attachmentPath(file: FilePart): string {
  return `attachments/${file.name}`;
}

export interface ModelView {
  items: ConversationItem[];
  /** The bytes of the files that go to the model directly, by name. */
  files: Map<string, Uint8Array>;
}

/**
 * The conversation with every attached file turned into what a model with `inputs` can take in.
 * A file that can no longer be read is named as missing rather than failing the call.
 */
export async function modelView(
  items: readonly ConversationItem[],
  inputs: readonly FileInput[],
  read: (name: string) => Promise<Uint8Array>,
): Promise<ModelView> {
  const files = new Map<string, Uint8Array>();
  const out: ConversationItem[] = [];
  for (const item of items) {
    if (item.type !== "message" || !item.content.some((part) => part.type === "file")) {
      out.push(item);
      continue;
    }
    const content: ContentPart[] = [];
    for (const part of item.content) {
      if (part.type !== "file") {
        content.push(part);
        continue;
      }
      const path = attachmentPath(part);
      const kind = fileKind(part);
      try {
        if (kind === "text") {
          const body = new TextDecoder().decode(await read(part.name));
          content.push({ type: "text", text: `<file path="${path}">\n${body}\n</file>` });
        } else if (kind && inputs.includes(kind)) {
          if (!files.has(part.name)) files.set(part.name, await read(part.name));
          content.push({ type: "text", text: `[Attached file ${path}]` }, part);
        } else {
          content.push({
            type: "text",
            text: `[Attached file ${path} (${part.mediaType}, ${formatBytes(part.size)}). It is not shown to you here; open it from your scratch directory with the shell.]`,
          });
        }
      } catch {
        content.push({ type: "text", text: `[Attached file ${path} is no longer available]` });
      }
    }
    out.push({ ...item, content });
  }
  return { items: out, files };
}

/** Roughly how many characters of context a file takes, for the token estimate. */
export function fileChars(file: FilePart): number {
  switch (fileKind(file)) {
    case "image":
      return 6_400;
    case "pdf":
      return Math.max(6_400, Math.round(file.size / 8));
    case "text":
      return file.size;
    default:
      return 200;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

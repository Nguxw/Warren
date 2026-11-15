import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isTextType, MAX_IMAGE_BYTES } from "@warren/core";
import { type FilePart, MAX_UPLOAD_BYTES, type Upload } from "@warren/protocol";
import { runProcess } from "@warren/tools";

/**
 * Files people attach to tasks and messages (docs/003).
 *
 * A file is uploaded first and waits in `uploads/<id>/`, so the interface can upload while the
 * person is still writing. Sending the task or message claims it: the file moves to the task's
 * `attachments/`, which the daemon reads for the model and the interface, and a copy goes to
 * `scratch/attachments/`, where the model's sandboxed commands can read and process it. The log
 * keeps only a reference, so the file never changes after it is attached. Uploads nobody claims
 * are deleted after a day.
 */

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const UPLOAD_ID = /^[0-9a-f]{32}$/;
const STALE_MS = 24 * 60 * 60_000;
/** Image formats providers do not accept, converted to JPEG when uploaded. */
const CONVERTED_IMAGES = new Set(["image/heic", "image/heif", "image/tiff", "image/bmp"]);
const ACCEPTED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface Staged {
  name: string;
  mediaType: string;
  size: number;
  at: number;
}

export class Attachments {
  constructor(
    private readonly options: {
      /** Where uploads wait to be claimed. */
      uploads: string;
      /** The task's own directory, outside its sandbox. */
      taskDir(taskId: string): string;
      scratchOf(taskId: string): string;
      now?(): number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Keeps an uploaded file until a task or message claims it. */
  async stage(file: { name: string; type?: string; bytes: Uint8Array }): Promise<Upload> {
    if (file.bytes.length === 0) throw new AttachmentError(`${file.name} is empty`);
    if (file.bytes.length > MAX_UPLOAD_BYTES) {
      throw new AttachmentError(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    const dir = join(this.options.uploads, id);
    mkdirSync(dir, { recursive: true });
    let name = safeName(file.name);
    let mediaType = mediaTypeOf(name, file.bytes, file.type);
    let bytes = file.bytes;
    if (
      CONVERTED_IMAGES.has(mediaType) ||
      (ACCEPTED_IMAGES.has(mediaType) && bytes.length > MAX_IMAGE_BYTES)
    ) {
      const jpeg = await toJpeg(bytes, dir);
      if (jpeg) {
        name = `${name.slice(0, name.length - extname(name).length) || "image"}.jpg`;
        mediaType = "image/jpeg";
        bytes = jpeg;
      }
    }
    writeFileSync(join(dir, name), bytes);
    const staged: Staged = { name, mediaType, size: bytes.length, at: this.now() };
    writeFileSync(join(dir, "upload.json"), JSON.stringify(staged));
    return { id, name, mediaType, size: bytes.length };
  }

  /** Removes an upload the person took back before sending. */
  discard(id: string): void {
    if (!UPLOAD_ID.test(id)) throw new AttachmentError(`no upload ${id}`, 404);
    rmSync(join(this.options.uploads, id), { recursive: true, force: true });
  }

  /**
   * Moves uploads into a task, in order, and returns them as file parts. Every id is checked
   * before anything moves, so a wrong id changes nothing.
   */
  claim(taskId: string, ids: readonly string[]): FilePart[] {
    const staged = ids.map((id) => {
      const meta = UPLOAD_ID.test(id) ? join(this.options.uploads, id, "upload.json") : "";
      if (!meta || !existsSync(meta)) {
        throw new AttachmentError(`no upload ${id}; it may have expired, attach the file again`);
      }
      return { id, ...(JSON.parse(readFileSync(meta, "utf8")) as Staged) };
    });
    if (staged.length === 0) return [];
    const dir = join(this.options.taskDir(taskId), "attachments");
    const copies = join(this.options.scratchOf(taskId), "attachments");
    mkdirSync(dir, { recursive: true });
    mkdirSync(copies, { recursive: true });
    const taken = new Set(readdirSync(dir));
    return staged.map((upload) => {
      const name = unique(upload.name, taken);
      taken.add(name);
      const target = join(dir, name);
      renameSync(join(this.options.uploads, upload.id, upload.name), target);
      // A clone on APFS: the copy takes no space until the model changes it.
      copyFileSync(target, join(copies, name), constants.COPYFILE_FICLONE);
      rmSync(join(this.options.uploads, upload.id), { recursive: true, force: true });
      return { type: "file", name, mediaType: upload.mediaType, size: upload.size };
    });
  }

  /** The path of a task's attachment; only names the task was given resolve. */
  path(taskId: string, name: string): string {
    const path = join(this.options.taskDir(taskId), "attachments", name);
    if (name !== safeName(name) || !existsSync(path)) {
      throw new AttachmentError(`no attachment ${name}`, 404);
    }
    return path;
  }

  async read(taskId: string, name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(taskId, name)));
  }

  /** Deletes uploads older than a day that no task or message claimed. */
  sweep(): void {
    if (!existsSync(this.options.uploads)) return;
    for (const id of readdirSync(this.options.uploads)) {
      const dir = join(this.options.uploads, id);
      if (this.now() - statSync(dir).mtimeMs > STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

/**
 * A name that is safe as one path component and readable in a shell: no directories, control
 * characters or leading dots, at most 120 characters with the extension kept.
 */
export function safeName(name: string): string {
  const base = (name.split(/[/\\]/).at(-1) ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
    .replace(/[\u0000-\u001f\u007f:]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (!base || base === "upload.json") return "file";
  if (base.length <= 120) return base;
  const ext = extname(base).slice(0, 16);
  return base.slice(0, 120 - ext.length) + ext;
}

/** `report.pdf`, then `report (2).pdf`, and so on. */
function unique(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The media type, from the file's first bytes where they tell, then its extension. A file of
 * valid UTF-8 text is text whatever its extension says (`.ts` is not a video), so the model
 * can read it.
 */
export function mediaTypeOf(name: string, bytes: Uint8Array, claimed?: string): string {
  const head = Buffer.from(bytes.subarray(0, 16));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (/^ftyp(heic|heix|hevc|mif1|msf1)$/.test(head.subarray(4, 12).toString("latin1"))) {
    return "image/heic";
  }
  const byName = (Bun.file(name).type.split(";")[0] ?? "").trim();
  if (byName.startsWith("image/")) return byName;
  if (looksLikeText(bytes)) return isTextType(byName) ? byName : "text/plain";
  const fallback = claimed?.split(";")[0]?.trim();
  if (byName && byName !== "application/octet-stream") return byName;
  return fallback || "application/octet-stream";
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: sample !== bytes });
    return true;
  } catch {
    return false;
  }
}

/** Converts an image to a JPEG of at most 2048 px a side with macOS's `sips`; undefined if it cannot. */
async function toJpeg(bytes: Uint8Array, dir: string): Promise<Uint8Array | undefined> {
  if (process.platform !== "darwin") return undefined;
  const source = join(dir, ".source");
  const target = join(dir, ".converted.jpg");
  try {
    writeFileSync(source, bytes);
    const result = await runProcess(
      [
        "sips",
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "82",
        "-Z",
        "2048",
        source,
        "--out",
        target,
      ],
      { cwd: dir, timeoutMs: 60_000, signal: AbortSignal.timeout(60_000) },
    );
    if (result.exitCode !== 0 || !existsSync(target)) return undefined;
    const jpeg = new Uint8Array(readFileSync(target));
    return jpeg.length <= MAX_IMAGE_BYTES ? jpeg : undefined;
  } finally {
    rmSync(source, { force: true });
    rmSync(target, { force: true });
  }
}

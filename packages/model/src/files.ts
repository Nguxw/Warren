import type { ContentPart, FilePart } from "@warren/protocol";

/**
 * Attached files on their way to a provider. The loop has already decided which files a model
 * takes in directly and passes their bytes; a file part without bytes is left out, because the
 * conversation names it in text.
 */

export type Files = ReadonlyMap<string, Uint8Array>;

/** The file parts that go to the model, with their bytes as base64. */
export function sentFile(
  part: ContentPart,
  files: Files | undefined,
): (FilePart & { base64: string }) | undefined {
  if (part.type !== "file") return undefined;
  const bytes = files?.get(part.name);
  return bytes ? { ...part, base64: Buffer.from(bytes).toString("base64") } : undefined;
}

export function dataUrl(file: { mediaType: string; base64: string }): string {
  return `data:${file.mediaType};base64,${file.base64}`;
}

export function joinText(parts: readonly ContentPart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

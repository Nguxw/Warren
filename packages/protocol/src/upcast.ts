import { z } from "zod";
import { EVENT_VERSIONS, type TaskEvent, TaskEvent as TaskEventSchema } from "./events.ts";

/**
 * Reading stored events.
 *
 * A stored event keeps the shape it was written with. When an event type's data changes,
 * its version goes up and one upcaster is added here that turns version n into n + 1.
 * Reading applies the chain, so every caller only ever sees current shapes.
 */

type Upcaster = (data: unknown) => unknown;

/** `UPCASTERS[type][n - 1]` upgrades data of version n to version n + 1. Empty while all are v1. */
export const UPCASTERS: Partial<Record<TaskEvent["type"], readonly Upcaster[]>> = {};

const StoredEnvelope = z.looseObject({
  type: z.string(),
  v: z.number().int().positive(),
  data: z.unknown(),
});

export class EventFormatError extends Error {
  override name = "EventFormatError";
}

export function parseEvent(raw: unknown, upcasters = UPCASTERS): TaskEvent {
  const stored = StoredEnvelope.safeParse(raw);
  if (!stored.success) {
    throw new EventFormatError(`not an event: ${stored.error.message}`);
  }
  const { type } = stored.data;
  let { v, data } = stored.data;
  if (!(type in EVENT_VERSIONS)) {
    throw new EventFormatError(`unknown event type "${type}"`);
  }
  const current = EVENT_VERSIONS[type as TaskEvent["type"]];
  if (v > current) {
    throw new EventFormatError(`"${type}" v${v} is newer than this build (v${current})`);
  }
  data = upcast(type, data, v, current, upcasters[type as TaskEvent["type"]] ?? []);
  v = current;
  const parsed = TaskEventSchema.safeParse({ ...stored.data, v, data });
  if (!parsed.success) {
    throw new EventFormatError(`invalid "${type}" event: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Runs `data` of version `from` through `chain` up to version `to`. */
export function upcast(
  type: string,
  data: unknown,
  from: number,
  to: number,
  chain: readonly Upcaster[],
): unknown {
  let result = data;
  for (let v = from; v < to; v += 1) {
    const step = chain[v - 1];
    if (!step) throw new EventFormatError(`no upcaster for "${type}" v${v}`);
    result = step(result);
  }
  return result;
}

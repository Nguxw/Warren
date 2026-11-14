import type { Schedule } from "@warren/protocol";

/**
 * When scheduled work is due. Pure functions of a schedule and times (Unix milliseconds), in the
 * local time zone of the process, so a "daily at 09:00" follows the computer's clock across
 * daylight saving changes.
 */

const HOUR = 3_600_000;

/** The first time strictly after `after` that the schedule is due. */
export function nextRun(schedule: Schedule, after: number): number {
  if (schedule.kind === "interval") return after + schedule.hours * HOUR;
  const [hours = 0, minutes = 0] = schedule.time.split(":").map(Number);
  const days = schedule.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : schedule.days;
  const start = new Date(after);
  // A week and a day covers every weekly schedule, whatever the starting weekday.
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      hours,
      minutes,
    );
    if (candidate.getTime() > after && days.includes(candidate.getDay())) {
      return candidate.getTime();
    }
  }
  throw new Error("a schedule without a day");
}

/**
 * The run that is due at `now`, counting from the previous run (or from when the automation
 * was created): the latest scheduled time in (since, now], or undefined if none has come.
 * Runs missed while the computer slept collapse into this one.
 */
export function dueRun(schedule: Schedule, since: number, now: number): number | undefined {
  let due: number | undefined;
  for (let at = nextRun(schedule, since); at <= now; at = nextRun(schedule, at)) due = at;
  return due;
}

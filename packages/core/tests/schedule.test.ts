import { describe, expect, test } from "bun:test";
import type { Schedule } from "@warren/protocol";
import { dueRun, nextRun } from "../src/index.ts";

// Local times, so the tests hold in any time zone.
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 10, day, hours, minutes).getTime(); // November 2026; the 14th is a Saturday

describe("nextRun", () => {
  test("daily: later today, or tomorrow once the time has passed", () => {
    const daily = { kind: "daily", time: "09:00" } as const;
    expect(nextRun(daily, at(14, 8))).toBe(at(14, 9));
    expect(nextRun(daily, at(14, 9))).toBe(at(15, 9));
    expect(nextRun(daily, at(14, 23, 59))).toBe(at(15, 9));
  });

  test("weekly: the next listed weekday", () => {
    const weekdays: Schedule = { kind: "weekly", days: [1, 2, 3, 4, 5], time: "18:30" };
    expect(nextRun(weekdays, at(14, 12))).toBe(at(16, 18, 30)); // Saturday → Monday
    expect(nextRun(weekdays, at(16, 18, 30))).toBe(at(17, 18, 30));
    const sundays: Schedule = { kind: "weekly", days: [0], time: "07:00" };
    expect(nextRun(sundays, at(15, 7))).toBe(at(22, 7));
  });

  test("interval: counted from the previous run", () => {
    expect(nextRun({ kind: "interval", hours: 6 }, at(14, 9))).toBe(at(14, 15));
  });
});

describe("dueRun", () => {
  const daily = { kind: "daily", time: "09:00" } as const;

  test("nothing is due before the first scheduled time", () => {
    expect(dueRun(daily, at(14, 8), at(14, 8, 59))).toBeUndefined();
    expect(dueRun(daily, at(14, 8), at(14, 9))).toBe(at(14, 9));
  });

  test("runs missed while the computer slept collapse into the latest one", () => {
    expect(dueRun(daily, at(10, 9), at(14, 12))).toBe(at(14, 9));
    expect(dueRun({ kind: "interval", hours: 1 }, at(14, 0), at(14, 5, 30))).toBe(at(14, 5));
  });
});

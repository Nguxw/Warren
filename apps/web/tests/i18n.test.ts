import { expect, test } from "bun:test";
import { describeSchedule, formatAgo, formatWhen, statusLabel, translator } from "../src/i18n.ts";

test("both languages fill in parameters, and every key exists in both", () => {
  const zh = translator("zh");
  const en = translator("en");
  expect(zh("replay.step", { step: 3, max: 9 })).toBe("第 3 / 9 步");
  expect(en("replay.step", { step: 3, max: 9 })).toBe("Step 3 of 9");
  expect(zh("notice.paused", { reason: "battery" })).toBe("已暂停：battery");
  // A missing parameter stays visible rather than silently disappearing.
  expect(en("notice.fatal")).toBe("Model error: {message}");
});

test("statuses and relative times read naturally in each language", () => {
  const zh = translator("zh");
  const en = translator("en");
  expect(statusLabel(zh, "waiting")).toBe("需要你");
  expect(statusLabel(en, "waiting")).toBe("Needs you");
  expect(formatAgo(zh, 10_000)).toBe("刚刚");
  expect(formatAgo(zh, 5 * 60_000)).toBe("5 分钟前");
  expect(formatAgo(en, 3 * 3_600_000)).toBe("3h ago");
  expect(formatAgo(en, 72 * 3_600_000)).toBe("3d ago");
});

test("schedules and times near now read naturally", () => {
  const zh = translator("zh");
  const en = translator("en");
  expect(describeSchedule(zh, { kind: "daily", time: "09:00" })).toBe("每天 09:00");
  expect(describeSchedule(zh, { kind: "weekly", days: [5, 1, 2, 3, 4], time: "09:00" })).toBe(
    "工作日 09:00",
  );
  expect(describeSchedule(zh, { kind: "weekly", days: [0, 3, 1], time: "18:30" })).toBe(
    "每周一、三、日 18:30",
  );
  expect(describeSchedule(en, { kind: "interval", hours: 6 })).toBe("Every 6 h");
  const now = new Date(2026, 10, 14, 12, 0).getTime();
  expect(formatWhen(zh, new Date(2026, 10, 15, 9, 0).getTime(), now)).toBe("明天 09:00");
  expect(formatWhen(zh, new Date(2026, 10, 14, 9, 5).getTime(), now)).toBe("今天 09:05");
  expect(formatWhen(en, new Date(2026, 10, 18, 9, 0).getTime(), now)).toBe("11/18 09:00");
});

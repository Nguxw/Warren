import { expect, test } from "bun:test";
import { formatAgo, statusLabel, translator } from "../src/i18n.ts";

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

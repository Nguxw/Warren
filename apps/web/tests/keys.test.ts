import { expect, test } from "bun:test";
import { COMPOSITION_GRACE_MS, isSend } from "../src/keys.ts";

const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
const idle = { composing: false, endedAt: Number.NEGATIVE_INFINITY };

test("Enter sends; Shift+Enter and other keys do not", () => {
  expect(isSend(enter, idle, 1000)).toBe(true);
  expect(isSend({ ...enter, shiftKey: true }, idle, 1000)).toBe(false);
  expect(isSend({ ...enter, key: "a" }, idle, 1000)).toBe(false);
});

test("Enter that confirms an input method's word never sends, in any browser's event order", () => {
  // Chrome: the keydown is marked as composing.
  expect(isSend({ ...enter, isComposing: true }, idle, 1000)).toBe(false);
  // WebKit (Safari, the desktop shell): keyCode 229, or the composition just ended before it.
  expect(isSend({ ...enter, keyCode: 229 }, idle, 1000)).toBe(false);
  expect(isSend(enter, { composing: true, endedAt: 0 }, 1000)).toBe(false);
  expect(isSend(enter, { composing: false, endedAt: 1000 }, 1000 + 5)).toBe(false);
  // A real Enter after the word is in: sends.
  expect(isSend(enter, { composing: false, endedAt: 1000 }, 1000 + COMPOSITION_GRACE_MS + 1)).toBe(
    true,
  );
});

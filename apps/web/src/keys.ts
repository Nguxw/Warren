import { type CompositionEvent, type KeyboardEvent, useRef } from "react";

/**
 * Enter to send, without breaking input methods (Chinese, Japanese, Korean), where Enter also
 * confirms the word being composed.
 *
 * Browsers disagree on how that Enter looks. Chrome marks its keydown `isComposing`. WebKit (Safari,
 * and the macOS desktop shell's web view) ends the composition first and then sends the keydown
 * with `isComposing` false, often with keyCode 229. So an Enter counts as the input method's when
 * any of these hold: the event says so, its keyCode is 229, a composition is open, or one ended
 * a moment ago.
 */

/** How long after a composition ends an Enter still belongs to it. */
export const COMPOSITION_GRACE_MS = 100;

export interface KeyFacts {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

export interface CompositionState {
  composing: boolean;
  /** When the last composition ended, in the clock of `now`; -Infinity if never. */
  endedAt: number;
}

/** Whether this key press sends the text (a pure function, so it can be tested). */
export function isSend(key: KeyFacts, state: CompositionState, now: number): boolean {
  if (key.key !== "Enter" || key.shiftKey) return false;
  if (key.isComposing || key.keyCode === 229 || state.composing) return false;
  return now - state.endedAt > COMPOSITION_GRACE_MS;
}

/**
 * Props for a text box that sends on Enter: Shift+Enter is a new line, and Enter that confirms an
 * input method's candidate stays with the input method.
 */
export function useEnterToSend<T extends HTMLTextAreaElement | HTMLInputElement>(
  onSend: () => void,
) {
  const state = useRef<CompositionState>({ composing: false, endedAt: Number.NEGATIVE_INFINITY });
  return {
    onCompositionStart: (_: CompositionEvent<T>) => {
      state.current.composing = true;
    },
    onCompositionEnd: (_: CompositionEvent<T>) => {
      state.current = { composing: false, endedAt: performance.now() };
    },
    onKeyDown: (event: KeyboardEvent<T>) => {
      const facts = {
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      };
      if (!isSend(facts, state.current, performance.now())) return;
      event.preventDefault();
      onSend();
    },
  };
}

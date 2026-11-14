import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "../context.tsx";
import { Close } from "../icons.tsx";

/**
 * A small button with a menu above or below it; closes on a choice, a click outside or Escape.
 * `onClear` adds a clear button next to it, for a choice that can be unset.
 */
export function Menu(props: {
  trigger: ReactNode;
  active: boolean;
  title?: string;
  onClear?: (() => void) | undefined;
  /** Where the menu opens; above by default, for a bar at the bottom of a box. */
  placement?: "above" | "below";
  /** Extra classes for the trigger and the menu. */
  className?: string;
  children(close: () => void): ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu-root ${props.className ?? ""}`} ref={root}>
      <span className={`bar-button ${props.active ? "on" : ""} ${open ? "open" : ""}`}>
        <button
          type="button"
          className="bar-trigger"
          title={props.title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {props.trigger}
        </button>
        {props.onClear && (
          <button
            type="button"
            className="bar-clear"
            title={t("home.clear")}
            onClick={props.onClear}
          >
            <Close size={12} />
          </button>
        )}
      </span>
      {open && (
        <div className={`menu ${props.placement ?? "above"}`}>
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

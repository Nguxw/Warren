import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One choice in the slash menu: a skill to use, or an action on the task being written. */
export interface Command {
  key: string;
  group: string;
  icon: ReactNode;
  label: string;
  detail?: string | undefined;
  /** Shown on the right, such as the current value of a setting. */
  hint?: string | undefined;
  /** Other words it is found by, such as its English name. */
  keywords?: string;
  run(): void;
}

/**
 * The menu above the text box, opened by typing `/` or pressing +. It only shows; the text box
 * keeps the focus and drives it with the arrow keys, Enter or Tab, and Escape.
 */
export function CommandMenu(props: {
  commands: Command[];
  active: number;
  empty: string;
  onHover(index: number): void;
  onChoose(command: Command): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Opens on the side of the text box with more room, as tall as that room allows.
  const [place, setPlace] = useState<{ below: boolean; height: number }>({
    below: false,
    height: 360,
  });
  useLayoutEffect(() => {
    const box = list.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    const above = box.top - 16;
    const below = window.innerHeight - box.bottom - 16;
    const useBelow = below > above;
    setPlace({ below: useBelow, height: Math.max(120, Math.min(360, useBelow ? below : above)) });
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${props.active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.active]);

  let lastGroup: string | undefined;
  return (
    <div
      className={`command-menu ${place.below ? "below" : ""}`}
      style={{ maxHeight: place.height }}
      ref={list}
      role="listbox"
    >
      {props.commands.length === 0 && <p className="command-empty">{props.empty}</p>}
      {props.commands.map((command, index) => {
        const heading = command.group !== lastGroup ? command.group : undefined;
        lastGroup = command.group;
        return (
          <div key={command.key}>
            {heading && <p className="command-group">{heading}</p>}
            <button
              type="button"
              role="option"
              aria-selected={index === props.active}
              data-index={index}
              className={`command-item ${index === props.active ? "on" : ""}`}
              // Keep the focus in the text box: choosing must not blur it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => props.onHover(index)}
              onClick={() => props.onChoose(command)}
            >
              <span className="command-icon">{command.icon}</span>
              <span className="command-text">
                <span className="command-label">{command.label}</span>
                {command.detail && <span className="command-detail">{command.detail}</span>}
              </span>
              {command.hint && <span className="command-hint">{command.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

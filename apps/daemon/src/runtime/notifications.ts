import type { TaskEvent } from "@warren/protocol";

/**
 * Desktop notifications, only for the moments that are worth a person's attention: a task needs
 * an answer or an approval, or it has finished. Everything else stays in the inbox.
 */

export type Notify = (title: string, body: string) => void;

export function taskNotifications(
  titleOf: (taskId: string) => string | undefined,
  notify: Notify,
): (events: TaskEvent[]) => void {
  return (events) => {
    for (const event of events) {
      const task = titleOf(event.taskId) ?? "Warren task";
      if (event.type === "attention.requested") {
        const what = event.data.kind === "approval" ? "Needs your approval" : "Has a question";
        notify(`${what}: ${task}`, event.data.prompt);
      } else if (event.type === "task.ended" && event.data.outcome !== "cancelled") {
        const what = event.data.outcome === "completed" ? "Done" : "Failed";
        notify(`${what}: ${task}`, event.data.summary ?? "");
      }
    }
  };
}

/**
 * macOS Notification Center through osascript. Text goes in as script arguments, never into the
 * script itself, because a prompt can come from the model.
 */
export const macNotify: Notify = (title, body) => {
  Bun.spawn(
    [
      "/usr/bin/osascript",
      "-e",
      "on run argv",
      "-e",
      'display notification (item 2 of argv) with title "Warren" subtitle (item 1 of argv)',
      "-e",
      "end run",
      "--",
      clip(title, 120),
      clip(body, 240),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

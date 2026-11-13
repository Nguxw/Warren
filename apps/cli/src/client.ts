import { existsSync, readFileSync } from "node:fs";
import { warrenPaths } from "@warren/daemon";
import { DaemonInfo, type TaskEvent } from "@warren/protocol";

export class CliError extends Error {
  override name = "CliError";
}

const NOT_RUNNING = "Warren daemon is not running. Start it with: warren daemon";

/** A thin HTTP client for the local daemon, found through `<WARREN_HOME>/daemon.json`. */
export class DaemonClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static connect(home?: string): DaemonClient {
    const file = warrenPaths(home).daemonInfo;
    if (!existsSync(file)) throw new CliError(NOT_RUNNING);
    const info = DaemonInfo.parse(JSON.parse(readFileSync(file, "utf8")));
    return new DaemonClient(`http://127.0.0.1:${info.port}`, info.token);
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(NOT_RUNNING);
    }
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new CliError(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  /** Yields a task's events after `afterSeq`, then live ones, until the caller stops. */
  async *stream(taskId: string, afterSeq: number, signal: AbortSignal): AsyncGenerator<TaskEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tasks/${taskId}/stream?after=${afterSeq}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal,
      });
    } catch {
      if (signal.aborted) return;
      throw new CliError(NOT_RUNNING);
    }
    if (!res.ok || !res.body) throw new CliError(`stream failed: HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === "task-event" && data) yield JSON.parse(data) as TaskEvent;
          end = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

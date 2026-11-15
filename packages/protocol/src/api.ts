import { z } from "zod";
import { Budget } from "./grant.ts";

/** Files one message may carry. */
export const MAX_ATTACHMENTS = 20;
/** The largest file that can be uploaded, in bytes. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * The daemon's HTTP API contract, shared by the CLI and the UI.
 * Breaking changes to these shapes need a new route, not an edit.
 */

export const TaskStatus = z.enum(["active", "waiting", "idle", "paused", "ended"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  triggerSource: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  /** Name of the folder (a repository or a copied folder) the task works on, if any. */
  repo?: string;
  /** Its local path. */
  repoPath?: string;
  /** How an ended task ended. */
  outcome?: "completed" | "failed" | "cancelled";
  /** What the task waits on, for tasks whose status is `waiting`. */
  attention?: { attentionId: string; kind: "question" | "approval"; prompt: string }[];
}

export const CreateTaskRequest = z.object({
  instruction: z.string().min(1),
  title: z.string().optional(),
  /**
   * A local folder the task works on: a git repository is cloned, any other folder copied. The
   * original is never written. Omit for an empty workspace.
   */
  repo: z.string().optional(),
  /** Where to offer saving the task's files when it ends; an absolute folder path. */
  outputDir: z.string().optional(),
  /** Skills the person chose for this task; the model loads them before it starts. */
  skills: z.array(z.string()).optional(),
  /** MCP servers the task may use, out of those turned on; all of them when absent. */
  mcpServers: z.array(z.string()).optional(),
  /** Model role from the config, such as `main` or `hard`. */
  modelRole: z.string().optional(),
  /** Whether the task's commands may reach the network; default from the config (off). */
  network: z.boolean().optional(),
  budget: Budget.optional(),
  /** Files uploaded with `POST /uploads`, by id, to attach to the instruction. */
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/** A message for a task: text, files uploaded with `POST /uploads`, or both. */
export const SendInputRequest = z
  .object({
    text: z.string(),
    attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
  })
  .refine((r) => r.text.trim().length > 0 || (r.attachments?.length ?? 0) > 0, {
    message: "a message needs text or a file",
  });
export type SendInputRequest = z.infer<typeof SendInputRequest>;

/** A file uploaded and waiting to be attached to a task or a message. */
export interface Upload {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export const ResolveAttentionRequest = z.object({
  response: z.string(),
  approved: z.boolean().optional(),
});
export type ResolveAttentionRequest = z.infer<typeof ResolveAttentionRequest>;

export interface ApiError {
  error: string;
}

/** Written by the daemon to `<WARREN_HOME>/daemon.json` (mode 0600) so clients can find it. */
export const DaemonInfo = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  token: z.string(),
  startedAt: z.number().int(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;

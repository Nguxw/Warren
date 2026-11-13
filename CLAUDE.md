# Warren

Local, always-on, long-horizon agent. TypeScript + Bun workspaces. Design docs in `docs/` (Chinese, numbered, read in order).

## Commands

- `bun run check` — typecheck (tsc 7) + Biome lint + tests; must pass before committing
- `bun test <path>` — run some tests
- `bun run format` — apply Biome formatting
- `WARREN_LIVE=1 bun test packages/model` — also run the real OpenAI API tests (both adapters)
- `bun run chaos [iterations] [seed]` — SIGKILL the real daemon repeatedly and check invariants; never edit `.ts` files while it runs (children load source)
- `bun apps/cli/src/main.ts <command>` — run the CLI from source; use `WARREN_HOME=<dir>` (and a different `server.port` in its config.json) for a throwaway instance
- `bun run build` — compile CLI, daemon and web UI into `dist/warren`

## Layout and dependency rules

- `packages/protocol` — event format, conversation items, Grant, API contract (zod). Depends on nothing internal.
- `packages/core` — fold, nextStep, the agent loop, port interfaces (`ports.ts`), test doubles (`@warren/core/testing`). Depends only on `protocol` and zod; no IO, no Bun APIs.
- Adapters implement `core` interfaces: `packages/model` (OpenAI Responses, OpenAI-compatible Chat Completions; shared error rules in `errors.ts`, shared contract tests in `tests/contract.test.ts`), `packages/tools` (built-in tools). Connectors come in M5.
- `evals/` — chaos harness; the crash scenario lives in `@warren/core/testing` (`push-scenario.ts`) and is shared with `packages/core/tests/simulation.test.ts`.
- `apps/daemon` is the composition root (`startDaemon`) and the only process that writes the database. `apps/cli` talks to it over HTTP using `daemon.json`.
- `apps/web` — React UI bundled by Bun's HTML import and served by the daemon at `/`. View logic lives in pure functions (`model.ts`, `i18n.ts`) with tests. Every UI string goes through `i18n.ts` (Chinese default, English); never hard-code interface text.
- `packages/connectors` — sources of work (GitHub). Events from webhooks and reconcile polls share content-based `externalId`s; `Intake` dedupes, routes (`core/routing.ts`, pure) and applies in one SQLite transaction.
- Design docs: `docs/000`–`007`.

## Rules that are expensive to break

- Stored events are never edited. To change an event type's data, bump its version in `EVENT_VERSIONS` and add an upcaster in `protocol/src/upcast.ts`. New event types need no version bump.
- The log stores Warren's own conversation items, never raw provider payloads.
- `tool.started` is committed before a tool runs; `external` tools are never re-run on recovery.
- Trusted code (the daemon, privileged tools) never runs git inside a workspace: its hooks and config are model-writable. Fetch from the source side, with hooks, fsmonitor and credential helpers disabled (see `packages/tools/src/privileged.ts`).
- Paths reach the Seatbelt profile only as `-D` parameters, never spliced into profile text.
- Migrations in `apps/daemon/src/store/migrations.ts` are forward-only; never edit a released one.
- Warren uses only its own credentials and `~/.warren` (`WARREN_HOME`); never read or write `~/.codex`, `~/.claude` or `gh` config.

## Conventions

- Code, comments and identifiers in English; docs in Chinese.
- Import workspace packages by name (`@warren/core`), local files with the `.ts` extension.
- Tests live in each package's `tests/` and use `bun:test`; use a fake clock rather than real time.

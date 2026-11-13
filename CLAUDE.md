# Warren

Local, always-on, long-horizon agent. TypeScript + Bun workspaces. Design docs in `docs/` (Chinese, numbered, read in order).

## Commands

- `bun run check` — typecheck (tsc 7) + Biome lint + tests; must pass before committing
- `bun test <path>` — run some tests
- `bun run format` — apply Biome formatting

## Layout and dependency rules

- `packages/protocol` — event format, conversation items, Grant (zod). Depends on nothing internal.
- `packages/core` — pure domain logic (fold, nextStep, later loop/context). Depends only on `protocol`; no IO, no Bun APIs.
- Adapters (`packages/model`, `tools`, `connectors`, added per milestone) implement interfaces defined in `core`.
- `apps/daemon` is the composition root and the only process that writes the database.

## Rules that are expensive to break

- Stored events are never edited. To change an event type's data, bump its version in `EVENT_VERSIONS` and add an upcaster in `protocol/src/upcast.ts`. New event types need no version bump.
- The log stores Warren's own conversation items, never raw provider payloads.
- `tool.started` is committed before a tool runs; `external` tools are never re-run on recovery.
- Migrations in `apps/daemon/src/store/migrations.ts` are forward-only; never edit a released one.
- Warren uses only its own credentials and `~/.warren` (`WARREN_HOME`); never read or write `~/.codex`, `~/.claude` or `gh` config.

## Conventions

- Code, comments and identifiers in English; docs in Chinese.
- Import workspace packages by name (`@warren/core`), local files with the `.ts` extension.
- Tests live in each package's `tests/` and use `bun:test`; use a fake clock rather than real time.

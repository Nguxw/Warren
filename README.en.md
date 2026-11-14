<p align="center">
  <img src="docs/images/logo.svg" width="96" alt="Warren">
</p>

<h1 align="center">Warren</h1>

<p align="center">
  A long-running agent that lives on your own computer. Hand it research, code or files;<br>
  it works through them in the background, in its own workspace, and comes back when there is a result or a decision for you.
</p>

<p align="center">
  <a href="https://github.com/Nguxw/Warren/actions/workflows/ci.yml"><img src="https://github.com/Nguxw/Warren/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
  <img src="https://img.shields.io/badge/runtime-Bun-black.svg" alt="Bun">
</p>

<p align="center"><a href="README.md">中文</a> · English</p>

<p align="center">
  <img src="docs/images/task.jpg" width="860" alt="A finished research task: its summary and the report it wrote">
</p>

## Why Warren

Most coding agents are something you watch: a terminal session editing your directory step by step. Warren works the other way round: **it does the work while you do something else.**

- Hand over a task and walk away. Tasks run for minutes or hours in the background; sleep, crashes and restarts do not lose progress.
- It never touches your originals: a repository is cloned, any other folder copied, and results come back as a branch, a pull request or "Save to…", for you to take or leave.
- It interrupts you for three things only: a question, an action to approve, a result ready to use.

## Features

- **Durable and recoverable:** every task is an append-only event log in SQLite. Its state is a fold over the log, so after a crash the task continues from the log, and an interrupted external action (a push, a pull request) is never blindly repeated. Across 200 tasks and 519 `kill -9`s in the chaos test, no external action ran twice.
- **Sandboxed:** commands the model runs are confined by macOS Seatbelt: writes only to their own workspace, no reads of `~/.ssh`, the keychain or Warren's keys, network per task. Actions that need credentials are carried out by the daemon in fixed ways, and can require your approval.
- **Any model:** a provider-neutral conversation format with three adapters: OpenAI (Responses), OpenAI-compatible endpoints (DeepSeek, Qwen, Ollama, vLLM…) and Anthropic. Models are set per role (standard, deep, fast); long tasks compact their context automatically.
- **Results you can open:** reports and data files preview in the interface (Markdown, tables, images), open in Finder, or save to a folder of yours.
- **Automations:** tasks that start on a schedule, such as "every day at 9:00, research GitHub trending and save the report to the Desktop". Runs missed while the computer slept are made up once.
- **GitHub:** mention @warren in an issue to start work; its questions and conclusions are posted back. Inferred work such as CI failures is observed first and switched to automatic once you trust it.
- **Interface:** a bilingual (Chinese and English) web interface and a macOS desktop app (Tauri) with a live timeline, replay and notifications, plus a complete CLI.
- **Its own credentials only:** everything lives in `~/.warren/`; Warren uses the API keys you give it and never reads or writes the configuration or login of Claude Code, Codex or `gh`.

## Quick start

**Requirements:** macOS 13 or later, [Bun](https://bun.sh) 1.4+, git, and an API key for a model (OpenAI, Anthropic or any OpenAI-compatible endpoint; a local Ollama needs none).

```sh
git clone https://github.com/Nguxw/Warren.git
cd Warren
bun install
bun run build                       # a single executable, dist/warren, interface included
cp dist/warren /usr/local/bin/      # or any directory on your PATH

warren service install              # start the daemon at login (launchd); or run `warren daemon` in a terminal
warren open                         # open the interface in your browser
```

Then add your key under **Settings → API keys** (bottom left) and hand over your first task. Or write the key file yourself:

```sh
mkdir -p ~/.warren && chmod 700 ~/.warren
echo 'WARREN_OPENAI_API_KEY=sk-...' >> ~/.warren/credentials.env
chmod 600 ~/.warren/credentials.env
```

**Desktop app (optional),** with a Rust toolchain (`brew install rustup && rustup default stable`):

```sh
cd apps/desktop && bun run build
open src-tauri/target/release/bundle/macos/Warren.app
```

`warren doctor` checks the configuration, keys and sandbox.

## Command line

```sh
warren run "Summarise this week's Bun releases"                  # start a task and follow it
warren run --repo ~/code/app "Fix the failing date tests, commit and publish the branch"
warren run --network --repo ~/Documents/notes --output ~/Desktop "Turn these notes into one summary"
warren tasks [--all]            # tasks in progress (or all)
warren answer <id> "<answer>"   # answer a task's question
warren approve <id>             # approve a waiting action; warren deny <id> "<reason>" refuses it
warren save <id> [<dir>]        # save a task's files
warren delete <id> --yes        # delete a task and its workspace
warren automations [run <id>]   # list automations, or run one now
warren stats                    # success rate, cost, time, interruptions, cache hit rate
```

## How it works

```
apps        web (interface) · desktop (Tauri shell) · cli
                       │  HTTP + SSE (127.0.0.1, token)
daemon      API · scheduler · automations · connector intake · store (SQLite, sole writer)
core        state fold · agent loop · context compaction · routing · schedules   (pure, no IO)
adapters    model/ (OpenAI · compatible · Anthropic)   tools/ + sandbox   connectors/ (GitHub)
protocol    event format · conversation items · Grant · API contract            (shared)
```

- **The log is the only source of truth.** Each step reads state, acts, and appends events. `tool.started` reaches the disk before a tool runs (`synchronous = FULL`), so after a crash Warren knows which actions may have happened: reads and workspace writes run again; external actions are reported to the model as "outcome unknown" to check before retrying.
- **Boundaries by mechanism, not by prompt.** What a task may touch (workspace, network, privileged tools, budget) is fixed in its Grant when it is created; the sandbox and the privileged tools enforce it.

The design documents in [`docs/`](docs) (in Chinese) are meant to be read in order, from [000 Philosophy](docs/000-philosophy.md) to [010 Automations](docs/010-automations.md).

## Evaluation

| Evaluation | Result |
|---|---|
| [SWE-bench Verified](docs/009-swebench.md), 28 random instances, official harness | 23 resolved (82%); median $0.16 and 2.1 minutes per instance (`gpt-6.1-terra`) |
| [Chaos test](docs/004-testing.md): `kill -9` the real daemon at random moments | 200 tasks, 519 kills, 0 invariant violations |
| [Crash simulation](docs/004-testing.md): crash after every persisted step (exhaustive and 500 random runs) | external actions run exactly once |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the rules that are expensive to break, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE)

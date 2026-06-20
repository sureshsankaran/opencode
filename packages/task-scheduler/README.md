# @opencode-ai/task-scheduler

An always-on background daemon that fires **scheduled prompts** into a running
`opencode serve` instance. It is the backend for the web UI's **Scheduled Tasks**
page (`/tasks`), so automation tasks run 24/7 — even when no browser tab is open.

## How it works

```
┌─────────────┐   control API    ┌──────────────────┐   HTTP API    ┌──────────────┐
│  web UI      │ ───────────────▶ │  task-scheduler  │ ────────────▶ │ opencode      │
│ (/tasks page)│   :5055          │  daemon          │   :5050       │ serve         │
└─────────────┘                  └──────────────────┘               └──────────────┘
                                          │
                                          ▼
                                 ~/.config/opencode/tasks.json
```

- The daemon **owns the canonical task store** (`~/.config/opencode/tasks.json`)
  and is the **sole executor** of scheduled runs.
- On its tick (every 30s) it finds due, enabled tasks, creates a new opencode
  session per task, and dispatches the task's prompt via `prompt_async`.
- The web UI detects the daemon via its `/status` endpoint. When connected, the
  UI defers all scheduling to the daemon (and suppresses its own in-browser
  timer to avoid double-firing). When the daemon is offline, the UI falls back
  to firing tasks itself while the tab is open.
- The default model for automation runs is **`github-copilot/claude-opus-4.6`**,
  falling back to the configured default / any connected model.

## Install (macOS / launchd)

```bash
cd packages/task-scheduler
./scripts/install.sh           # install + start as a launchd agent
./scripts/install.sh status    # show status + recent logs
./scripts/install.sh uninstall # stop + remove (tasks are preserved)
```

## Run manually

```bash
bun run src/daemon.ts
```

## Configuration (environment variables)

| Variable                   | Default                              | Purpose                                  |
| -------------------------- | ------------------------------------ | ---------------------------------------- |
| `OPENCODE_SERVER_URL`      | `http://localhost:5050`              | The opencode server to dispatch prompts to |
| `TASK_SCHEDULER_PORT`      | `5055`                               | Control API port                         |
| `TASK_SCHEDULER_HOST`      | `127.0.0.1`                          | Control API bind host                    |
| `OPENCODE_TASKS_FILE`      | `~/.config/opencode/tasks.json`      | Task store location                      |
| `OPENCODE_SERVER_PASSWORD` | _(unset)_                            | Basic-auth password if the server is secured |
| `OPENCODE_SERVER_USERNAME` | `opencode`                           | Basic-auth username                      |

## Control API

| Method + Path             | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `GET /status`             | Health, upstream status, resolved default model    |
| `GET /tasks`              | List all tasks                                      |
| `POST /tasks`             | Create a task                                       |
| `GET /tasks/:id`          | Get one task                                        |
| `PUT /tasks/:id`          | Update a task                                       |
| `DELETE /tasks/:id`       | Delete a task                                       |
| `POST /tasks/:id/run`     | Run a task immediately                              |
| `POST /tasks/:id/toggle`  | Enable/disable a task (`{ "enabled": bool }`)       |
| `POST /tasks/sync`        | Non-destructive bulk upsert (used for UI import)    |

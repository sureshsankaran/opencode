#!/usr/bin/env bun
/**
 * opencode-task-scheduler — an always-on daemon that fires scheduled prompts
 * into the running `opencode serve` instance, so automation tasks run even when
 * no browser tab is open.
 *
 * Storage:  ~/.config/opencode/tasks.json  (override: OPENCODE_TASKS_FILE)
 * Upstream: http://localhost:5050          (override: OPENCODE_SERVER_URL)
 * Control:  http://127.0.0.1:5055          (override: TASK_SCHEDULER_PORT)
 *
 * The daemon owns the canonical task store and is the sole executor of
 * scheduled runs. The web UI talks to it over the control API below.
 */

import { OpencodeClient } from "./opencode"
import { Scheduler, TICK_INTERVAL } from "./scheduler"
import { TaskStore } from "./store"
import { computeNextRun, newId, normalizeInput } from "./schedule"
import type { SchedulerStatus, Task } from "./types"

const VERSION = "0.0.1"
const START = Date.now()

const UPSTREAM = process.env["OPENCODE_SERVER_URL"] ?? "http://localhost:5050"
const PORT = Number(process.env["TASK_SCHEDULER_PORT"] ?? 5055)
const HOSTNAME = process.env["TASK_SCHEDULER_HOST"] ?? "127.0.0.1"

const client = new OpencodeClient(UPSTREAM, {
  username: process.env["OPENCODE_SERVER_USERNAME"],
  password: process.env["OPENCODE_SERVER_PASSWORD"],
})
const store = new TaskStore()
const scheduler = new Scheduler(store, client, { tickInterval: TICK_INTERVAL })

await store.load()
scheduler.start()

console.log(`[daemon] opencode-task-scheduler v${VERSION}`)
console.log(`[daemon] store:    ${store.path}`)
console.log(`[daemon] upstream: ${UPSTREAM}`)
console.log(`[daemon] tasks:    ${store.all().length}`)

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/** Build a full Task from validated input. */
function buildTask(input: ReturnType<typeof normalizeInput>): Task {
  const now = Date.now()
  return {
    id: newId(),
    name: input.name,
    directory: input.directory,
    prompt: input.prompt,
    agent: input.agent,
    model: input.model,
    scheduleType: input.scheduleType,
    intervalValue: input.intervalValue,
    timeOfDay: input.timeOfDay,
    enabled: input.enabled,
    createdAt: now,
    nextRun: computeNextRun(input, now),
    runCount: 0,
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/$/, "") || "/"
    const method = req.method

    if (method === "OPTIONS") return new Response(null, { headers: CORS })

    try {
      // --- Health / status -------------------------------------------------
      if (path === "/" || path === "/health" || path === "/status") {
        const tasks = store.all()
        const upstreamOnline = await client.ping()
        const defaultModel = upstreamOnline ? ((await client.resolveModel()) ?? null) : null
        const status: SchedulerStatus = {
          ok: true,
          service: "opencode-task-scheduler",
          version: VERSION,
          uptime: Date.now() - START,
          upstream: UPSTREAM,
          upstreamOnline,
          defaultModel,
          taskCount: tasks.length,
          enabledCount: tasks.filter((t) => t.enabled).length,
          tickInterval: TICK_INTERVAL,
          now: Date.now(),
        }
        return json(status)
      }

      // --- List / create ---------------------------------------------------
      if (path === "/tasks" && method === "GET") {
        return json({ tasks: store.all() })
      }

      if (path === "/tasks" && method === "POST") {
        const input = normalizeInput(await req.json())
        const task = buildTask(input)
        await store.upsert(task)
        return json({ task }, 201)
      }

      // --- Bulk merge (non-destructive import from the web UI) -------------
      // Upserts each incoming task by id. Daemon tasks absent from the payload
      // are left untouched, so importing browser-local tasks can never wipe
      // tasks that were created directly against the daemon.
      if (path === "/tasks/sync" && method === "POST") {
        const body = (await req.json()) as { tasks?: unknown }
        if (!Array.isArray(body?.tasks)) return error("Expected { tasks: [...] }")
        for (const raw of body.tasks) {
          const input = normalizeInput(raw)
          const incomingId = typeof (raw as Task).id === "string" ? (raw as Task).id : undefined
          const existing = incomingId ? store.get(incomingId) : undefined
          if (existing) {
            // Preserve runtime fields, apply incoming definition.
            await store.upsert({
              ...existing,
              name: input.name,
              directory: input.directory,
              prompt: input.prompt,
              agent: input.agent,
              model: input.model,
              scheduleType: input.scheduleType,
              intervalValue: input.intervalValue,
              timeOfDay: input.timeOfDay,
              enabled: input.enabled,
              nextRun: computeNextRun(input, Date.now()),
            })
          } else {
            const task = buildTask(input)
            if (incomingId) task.id = incomingId
            await store.upsert(task)
          }
        }
        return json({ tasks: store.all() })
      }

      // --- Single-task routes: /tasks/:id[/run|/toggle] --------------------
      const match = path.match(/^\/tasks\/([^/]+)(?:\/(run|toggle))?$/)
      if (match) {
        const id = decodeURIComponent(match[1]!)
        const action = match[2]
        const existing = store.get(id)

        if (action === "run" && method === "POST") {
          if (!existing) return error("Task not found", 404)
          const task = await scheduler.runNow(id)
          return json({ task })
        }

        if (action === "toggle" && method === "POST") {
          if (!existing) return error("Task not found", 404)
          const body = (await req.json().catch(() => ({}))) as { enabled?: boolean }
          const enabled = body.enabled ?? !existing.enabled
          const update: Partial<Task> = { enabled }
          if (enabled) update.nextRun = computeNextRun(existing, Date.now())
          const task = await store.patch(id, update)
          return json({ task })
        }

        if (!action && method === "GET") {
          if (!existing) return error("Task not found", 404)
          return json({ task: existing })
        }

        if (!action && method === "PUT") {
          if (!existing) return error("Task not found", 404)
          const input = normalizeInput(await req.json())
          const task = await store.patch(id, {
            name: input.name,
            directory: input.directory,
            prompt: input.prompt,
            agent: input.agent,
            model: input.model,
            scheduleType: input.scheduleType,
            intervalValue: input.intervalValue,
            timeOfDay: input.timeOfDay,
            enabled: input.enabled,
            nextRun: computeNextRun(input, Date.now()),
          })
          return json({ task })
        }

        if (!action && method === "DELETE") {
          const removed = await store.remove(id)
          if (!removed) return error("Task not found", 404)
          return json({ ok: true })
        }
      }

      return error("Not found", 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message, 400)
    }
  },
})

console.log(`[daemon] control API listening on http://${server.hostname}:${server.port}`)

// Graceful shutdown so launchd restarts get a clean slate.
function shutdown(signal: string) {
  console.log(`[daemon] received ${signal}, shutting down`)
  scheduler.stop()
  server.stop()
  process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

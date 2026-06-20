import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useServer } from "@/context/server"
import { Persist, persisted } from "@/utils/persist"
import { deriveDaemonUrl, TaskDaemonClient, type DaemonStatus } from "@/context/task-daemon"
import type { ScheduleType, Task, TaskInput } from "@/context/task-scheduler-types"

export type { ScheduleType, Task, TaskInput } from "@/context/task-scheduler-types"

const MINUTE = 60_000
const HOUR = 3_600_000
// How often the browser scheduler wakes up to check for due tasks (only used in
// local fallback mode; when the daemon is connected it does the firing).
const TICK_INTERVAL = 30_000
// How often we poll the daemon's status to detect online/offline transitions.
const DAEMON_POLL_INTERVAL = 15_000

// Preferred default model for automation tasks. Used whenever it is available
// from a connected provider; otherwise the scheduler falls back to the config
// default and then any connected model.
export const AUTOMATION_DEFAULT_MODEL = { providerID: "github-copilot", modelID: "claude-opus-4.6" } as const

function newId() {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return `tsk_${cryptoObj.randomUUID()}`
  return `tsk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

export function computeNextRun(
  task: Pick<Task, "scheduleType" | "intervalValue" | "timeOfDay">,
  from: number = Date.now(),
): number {
  if (task.scheduleType === "minutes") {
    const value = Math.max(1, task.intervalValue || 1)
    return from + value * MINUTE
  }
  if (task.scheduleType === "hours") {
    const value = Math.max(1, task.intervalValue || 1)
    return from + value * HOUR
  }
  // daily at HH:MM (local time)
  const [hh, mm] = (task.timeOfDay || "09:00").split(":").map((x) => Number.parseInt(x, 10))
  const next = new Date(from)
  next.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function describeSchedule(task: Pick<Task, "scheduleType" | "intervalValue" | "timeOfDay">): string {
  if (task.scheduleType === "minutes") {
    const value = Math.max(1, task.intervalValue || 1)
    return value === 1 ? "Every minute" : `Every ${value} minutes`
  }
  if (task.scheduleType === "hours") {
    const value = Math.max(1, task.intervalValue || 1)
    return value === 1 ? "Every hour" : `Every ${value} hours`
  }
  return `Daily at ${task.timeOfDay || "09:00"}`
}

/**
 * Pick a usable model for a scheduled run. Prefers the automation default
 * (Claude Opus 4.6) when available, then mirrors the fallback logic the prompt
 * input uses: the configured default model, then any connected provider's
 * default, then any connected model at all.
 */
function pickModel(
  providers: ProviderListResponse,
  configModel?: string,
): { providerID: string; modelID: string } | undefined {
  const valid = (providerID: string, modelID: string) => {
    if (!providers.connected.includes(providerID)) return false
    const provider = providers.all.find((p) => p.id === providerID)
    return !!provider && provider.models[modelID] !== undefined
  }

  // Always prefer the automation default model when its provider is connected.
  if (valid(AUTOMATION_DEFAULT_MODEL.providerID, AUTOMATION_DEFAULT_MODEL.modelID)) {
    return { ...AUTOMATION_DEFAULT_MODEL }
  }

  if (configModel) {
    const slash = configModel.indexOf("/")
    if (slash > 0) {
      const providerID = configModel.slice(0, slash)
      const modelID = configModel.slice(slash + 1)
      if (valid(providerID, modelID)) return { providerID, modelID }
    }
  }

  for (const provider of providers.all) {
    if (!providers.connected.includes(provider.id)) continue
    const def = providers.default[provider.id]
    if (def && provider.models[def]) return { providerID: provider.id, modelID: def }
  }

  for (const provider of providers.all) {
    if (!providers.connected.includes(provider.id)) continue
    const first = Object.keys(provider.models)[0]
    if (first) return { providerID: provider.id, modelID: first }
  }

  return undefined
}

function createTaskScheduler() {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const server = useServer()
  const navigate = useNavigate()

  const [store, setStore, , ready] = persisted(
    Persist.global("tasks.v1"),
    createStore({ tasks: [] as Task[] }),
  )

  // Daemon connection state. When connected, the daemon is the source of truth
  // and the sole executor; the browser tick is suppressed to avoid double-firing.
  const daemon = new TaskDaemonClient(deriveDaemonUrl(server.url))
  const [daemonStatus, setDaemonStatus] = createSignal<DaemonStatus | undefined>()
  const connected = createMemo(() => !!daemonStatus())
  let syncedOnce = false

  const tasks = createMemo(() => store.tasks)

  const find = (id: string) => store.tasks.findIndex((t) => t.id === id)

  function patch(id: string, update: Partial<Task>) {
    const index = find(id)
    if (index === -1) return
    setStore("tasks", index, update)
  }

  // Replace the local mirror with the daemon's authoritative list.
  function applyRemote(list: Task[]) {
    setStore("tasks", reconcile(list, { key: "id" }))
  }

  async function refreshFromDaemon() {
    try {
      const list = await daemon.list()
      applyRemote(list)
    } catch (err) {
      console.error("[tasks] failed to refresh from daemon:", err)
    }
  }

  function buildLocalTask(input: TaskInput): Task {
    const now = Date.now()
    return {
      id: newId(),
      name: input.name.trim() || "Untitled task",
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

  function add(input: TaskInput): Task {
    if (connected()) {
      // Optimistic insert, then reconcile with the daemon's response.
      const optimistic = buildLocalTask(input)
      setStore("tasks", (prev) => [optimistic, ...prev])
      void daemon
        .add(input)
        .then(() => refreshFromDaemon())
        .catch((err) => {
          showToast({ icon: "circle-x", title: "Couldn't save task", description: errorMessage(err) })
          void refreshFromDaemon()
        })
      return optimistic
    }

    const task = buildLocalTask(input)
    setStore("tasks", (prev) => [task, ...prev])
    return task
  }

  function update(id: string, input: TaskInput) {
    if (connected()) {
      patch(id, {
        name: input.name.trim() || "Untitled task",
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
      void daemon
        .update(id, input)
        .then(() => refreshFromDaemon())
        .catch((err) => {
          showToast({ icon: "circle-x", title: "Couldn't update task", description: errorMessage(err) })
          void refreshFromDaemon()
        })
      return
    }

    const existing = store.tasks[find(id)]
    if (!existing) return
    patch(id, {
      name: input.name.trim() || "Untitled task",
      directory: input.directory,
      prompt: input.prompt,
      agent: input.agent,
      model: input.model,
      scheduleType: input.scheduleType,
      intervalValue: input.intervalValue,
      timeOfDay: input.timeOfDay,
      enabled: input.enabled,
      // Recompute the next run from now whenever the schedule is edited.
      nextRun: computeNextRun(input, Date.now()),
    })
  }

  function remove(id: string) {
    setStore("tasks", (prev) => prev.filter((t) => t.id !== id))
    if (connected()) {
      void daemon.remove(id).catch((err) => {
        showToast({ icon: "circle-x", title: "Couldn't delete task", description: errorMessage(err) })
        void refreshFromDaemon()
      })
    }
  }

  function toggle(id: string, enabled: boolean) {
    const existing = store.tasks[find(id)]
    if (!existing) return
    const update: Partial<Task> = { enabled }
    // When re-enabling, schedule the next run relative to now so we don't
    // immediately fire a long-overdue task.
    if (enabled) update.nextRun = computeNextRun(existing, Date.now())
    patch(id, update)
    if (connected()) {
      void daemon
        .toggle(id, enabled)
        .then(() => refreshFromDaemon())
        .catch((err) => {
          showToast({ icon: "circle-x", title: "Couldn't update task", description: errorMessage(err) })
          void refreshFromDaemon()
        })
    }
  }

  async function execute(task: Task): Promise<string> {
    const providers = globalSync.data.provider
    const model = pickModel(providers, globalSync.data.config.model)
    if (!model) {
      throw new Error("No connected model available. Connect a provider first.")
    }

    const created = await globalSDK.client.session.create({
      directory: task.directory,
      title: task.name,
    })
    const sessionID = created.data?.id
    if (!sessionID) throw new Error("Failed to create session")

    await globalSDK.client.session.promptAsync({
      sessionID,
      directory: task.directory,
      model,
      agent: task.agent || undefined,
      parts: [{ type: "text", text: task.prompt }],
    })

    return sessionID
  }

  async function trigger(id: string, options: { scheduled: boolean }) {
    const index = find(id)
    if (index === -1) return
    const task = store.tasks[index]
    const now = Date.now()

    // Advance the schedule up front so a long-running create can't double-fire
    // on the next tick.
    if (options.scheduled) {
      patch(id, { nextRun: computeNextRun(task, now) })
    }

    patch(id, { lastRun: now, lastStatus: "running", lastError: undefined })

    try {
      const sessionID = await execute(task)
      patch(id, {
        lastStatus: "success",
        lastError: undefined,
        lastSessionID: sessionID,
        runCount: (store.tasks[find(id)]?.runCount ?? task.runCount) + 1,
      })
      showToast({
        icon: "task",
        title: "Task started",
        description: `"${task.name}" opened a new session.`,
        actions: [
          {
            label: "Go to session",
            onClick: () => navigate(`/${base64Encode(task.directory)}/session/${sessionID}`),
          },
          { label: "Dismiss", onClick: "dismiss" },
        ],
      })
    } catch (err) {
      const message = errorMessage(err)
      patch(id, { lastStatus: "error", lastError: message })
      showToast({
        icon: "circle-x",
        title: "Task failed",
        description: `"${task.name}": ${message}`,
      })
    }
  }

  function runNow(id: string) {
    if (connected()) {
      patch(id, { lastStatus: "running", lastError: undefined })
      return daemon
        .runNow(id)
        .then((task) => {
          if (task) setStore("tasks", find(id), reconcile(task, { key: "id" }))
          const sessionID = task?.lastSessionID
          showToast({
            icon: task?.lastStatus === "error" ? "circle-x" : "task",
            title: task?.lastStatus === "error" ? "Task failed" : "Task started",
            description:
              task?.lastStatus === "error"
                ? `"${task?.name}": ${task?.lastError ?? "unknown error"}`
                : `"${task?.name}" opened a new session.`,
            actions:
              sessionID && task?.lastStatus !== "error"
                ? [
                    {
                      label: "Go to session",
                      onClick: () => navigate(`/${base64Encode(task!.directory)}/session/${sessionID}`),
                    },
                    { label: "Dismiss", onClick: "dismiss" as const },
                  ]
                : undefined,
          })
          void refreshFromDaemon()
        })
        .catch((err) => {
          patch(id, { lastStatus: "error", lastError: errorMessage(err) })
          showToast({ icon: "circle-x", title: "Task failed", description: errorMessage(err) })
        })
    }
    return trigger(id, { scheduled: false })
  }

  // Agents available for a given project directory (for the picker). Bootstraps
  // the directory instance on demand; the list fills in reactively.
  function agentsFor(directory: string): Agent[] {
    if (!directory) return []
    const [child] = globalSync.child(directory)
    return child.agent.filter((a) => a.mode !== "subagent" && !a.hidden)
  }

  function hasModel(): boolean {
    return !!pickModel(globalSync.data.provider, globalSync.data.config.model)
  }

  let firing = false
  const tick = () => {
    // The daemon fires tasks when connected; the browser only fires in fallback.
    if (connected()) return
    if (firing) return
    const now = Date.now()
    const due = store.tasks.filter((t) => t.enabled && t.nextRun <= now)
    if (due.length === 0) return
    firing = true
    void (async () => {
      try {
        for (const task of due) {
          await trigger(task.id, { scheduled: true })
        }
      } finally {
        firing = false
      }
    })()
  }

  // Poll the daemon; manage the online/offline transition and initial import.
  const pollDaemon = async () => {
    const status = await daemon.status()
    const was = connected()
    setDaemonStatus(status)

    if (status) {
      // First time we see the daemon online: import any browser-local tasks
      // (non-destructive), then adopt the daemon's list as authoritative.
      if (!syncedOnce) {
        syncedOnce = true
        try {
          const localTasks = store.tasks.slice()
          const merged = localTasks.length > 0 ? await daemon.sync(localTasks) : await daemon.list()
          applyRemote(merged)
        } catch (err) {
          console.error("[tasks] initial daemon sync failed:", err)
          await refreshFromDaemon()
        }
      } else {
        await refreshFromDaemon()
      }
    } else if (was) {
      // Daemon just went offline; keep showing the last known tasks. The browser
      // tick will resume firing enabled tasks until it returns.
      syncedOnce = false
    }
  }

  onMount(() => {
    void pollDaemon()
    const poll = setInterval(() => void pollDaemon(), DAEMON_POLL_INTERVAL)
    // Small initial delay so providers/projects have a chance to load before the
    // first catch-up tick.
    const start = setTimeout(tick, 5_000)
    const interval = setInterval(tick, TICK_INTERVAL)
    onCleanup(() => {
      clearInterval(poll)
      clearTimeout(start)
      clearInterval(interval)
    })
  })

  return {
    ready,
    get tasks() {
      return tasks()
    },
    get connected() {
      return connected()
    },
    get daemonUrl() {
      return daemon.url
    },
    get(id: string) {
      return store.tasks.find((t) => t.id === id)
    },
    add,
    update,
    remove,
    toggle,
    runNow,
    agentsFor,
    hasModel,
  }
}

export const { use: useTaskScheduler, provider: TaskSchedulerProvider } = createSimpleContext({
  name: "TaskScheduler",
  gate: false,
  init: createTaskScheduler,
})

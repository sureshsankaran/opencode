import type { OpencodeClient } from "./opencode"
import type { TaskStore } from "./store"
import type { Task } from "./types"
import { computeNextRun } from "./schedule"

export const TICK_INTERVAL = 30_000

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * The scheduler engine. Wakes on a fixed interval, fires any due+enabled tasks
 * by creating a session and dispatching the prompt, and advances each task's
 * schedule. A `firing` guard plus advancing `nextRun` before the async create
 * prevents a slow run from double-firing on the next tick.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private firing = false

  constructor(
    private readonly store: TaskStore,
    private readonly client: OpencodeClient,
    private readonly opts: { tickInterval?: number; log?: (msg: string) => void } = {},
  ) {}

  private log(msg: string) {
    ;(this.opts.log ?? console.log)(`[scheduler] ${msg}`)
  }

  start(): void {
    if (this.timer) return
    const interval = this.opts.tickInterval ?? TICK_INTERVAL
    // Small initial delay so the upstream server has a chance to be reachable.
    setTimeout(() => void this.tick(), 5_000)
    this.timer = setInterval(() => void this.tick(), interval)
    this.log(`started, tick every ${Math.round(interval / 1000)}s`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run a single scheduling pass. Safe to call manually (e.g. on demand). */
  async tick(): Promise<void> {
    if (this.firing) return
    const now = Date.now()
    const due = this.store.all().filter((t) => t.enabled && t.nextRun <= now)
    if (due.length === 0) return
    this.firing = true
    try {
      for (const task of due) {
        await this.fire(task, { scheduled: true })
      }
    } finally {
      this.firing = false
    }
  }

  /** Execute a single task immediately (used by the /run endpoint). */
  async runNow(id: string): Promise<Task | undefined> {
    const task = this.store.get(id)
    if (!task) return undefined
    return this.fire(task, { scheduled: false })
  }

  private async fire(task: Task, options: { scheduled: boolean }): Promise<Task | undefined> {
    const now = Date.now()

    // Advance the schedule up front so a long-running create can't double-fire.
    if (options.scheduled) {
      await this.store.patch(task.id, { nextRun: computeNextRun(task, now) })
    }
    await this.store.patch(task.id, { lastRun: now, lastStatus: "running", lastError: undefined })

    try {
      const model = await this.client.resolveModel(task.model)
      if (!model) throw new Error("No connected model available. Connect a provider in opencode.")

      const sessionID = await this.client.createSession(task.directory, task.name)
      await this.client.promptAsync({
        sessionID,
        directory: task.directory,
        prompt: task.prompt,
        model,
        agent: task.agent,
      })

      const current = this.store.get(task.id)
      const updated = await this.store.patch(task.id, {
        lastStatus: "success",
        lastError: undefined,
        lastSessionID: sessionID,
        runCount: (current?.runCount ?? task.runCount) + 1,
      })
      this.log(`fired "${task.name}" (${task.id}) → session ${sessionID} [${model.providerID}/${model.modelID}]`)
      return updated
    } catch (err) {
      const message = errorMessage(err)
      const updated = await this.store.patch(task.id, { lastStatus: "error", lastError: message })
      this.log(`task "${task.name}" (${task.id}) failed: ${message}`)
      return updated
    }
  }
}

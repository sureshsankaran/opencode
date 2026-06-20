import type { Task, TaskInput } from "./types"

export const MINUTE = 60_000
export const HOUR = 3_600_000

/**
 * Compute the next run timestamp for a task. Identical logic to the browser
 * scheduler so a task behaves the same whether the daemon or the tab fires it.
 */
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
  const parts = (task.timeOfDay || "09:00").split(":")
  const hh = Number.parseInt(parts[0] ?? "9", 10)
  const mm = Number.parseInt(parts[1] ?? "0", 10)
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

export function newId(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return `tsk_${cryptoObj.randomUUID()}`
  return `tsk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Validate and normalize a TaskInput coming off the wire. Throws on bad input. */
export function normalizeInput(raw: unknown): TaskInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid task: expected an object")
  const o = raw as Record<string, unknown>

  const scheduleType = o.scheduleType
  if (scheduleType !== "minutes" && scheduleType !== "hours" && scheduleType !== "daily") {
    throw new Error(`Invalid scheduleType: ${String(scheduleType)}`)
  }

  const directory = typeof o.directory === "string" ? o.directory.trim() : ""
  if (!directory) throw new Error("Invalid task: directory is required")

  const prompt = typeof o.prompt === "string" ? o.prompt : ""
  if (!prompt.trim()) throw new Error("Invalid task: prompt is required")

  const intervalValueRaw = typeof o.intervalValue === "number" ? o.intervalValue : Number(o.intervalValue)
  const intervalValue = Number.isFinite(intervalValueRaw) ? Math.max(1, Math.floor(intervalValueRaw)) : 1

  const timeOfDay = typeof o.timeOfDay === "string" && /^\d{1,2}:\d{2}$/.test(o.timeOfDay) ? o.timeOfDay : "09:00"

  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Untitled task",
    directory,
    prompt,
    agent: typeof o.agent === "string" && o.agent.trim() ? o.agent.trim() : undefined,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined,
    scheduleType,
    intervalValue,
    timeOfDay,
    enabled: o.enabled !== false,
  }
}

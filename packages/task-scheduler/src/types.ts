/**
 * Shared types for the always-on task scheduler daemon.
 *
 * These mirror the browser-side `Task` type in
 * `packages/app/src/context/task-scheduler.tsx` so the web UI and the daemon
 * speak the same language over the control API.
 */

export type ScheduleType = "minutes" | "hours" | "daily"

export type TaskStatus = "running" | "success" | "error"

export interface Task {
  id: string
  name: string
  directory: string
  prompt: string
  agent?: string
  /** Explicit model override, "providerID/modelID". Falls back to the daemon default. */
  model?: string
  scheduleType: ScheduleType
  /** Interval count for "minutes" / "hours" schedules. */
  intervalValue: number
  /** "HH:MM" (local time) for "daily" schedules. */
  timeOfDay: string
  enabled: boolean
  createdAt: number
  nextRun: number
  lastRun?: number
  lastStatus?: TaskStatus
  lastError?: string
  lastSessionID?: string
  runCount: number
}

/** Fields a client may supply when creating or updating a task. */
export interface TaskInput {
  name: string
  directory: string
  prompt: string
  agent?: string
  model?: string
  scheduleType: ScheduleType
  intervalValue: number
  timeOfDay: string
  enabled: boolean
}

export interface SchedulerStatus {
  ok: true
  service: "opencode-task-scheduler"
  version: string
  uptime: number
  upstream: string
  upstreamOnline: boolean
  defaultModel: { providerID: string; modelID: string } | null
  taskCount: number
  enabledCount: number
  tickInterval: number
  now: number
}

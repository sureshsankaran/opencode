/**
 * Shared task types used by both the browser scheduler context and the daemon
 * client. Kept in a standalone module so importing the types never pulls in the
 * SolidJS context machinery (avoids import cycles).
 *
 * These mirror the daemon-side types in
 * `packages/task-scheduler/src/types.ts`.
 */

export type ScheduleType = "minutes" | "hours" | "daily"

export type Task = {
  id: string
  name: string
  directory: string
  prompt: string
  agent?: string
  /** Explicit model override, "providerID/modelID". Falls back to the default. */
  model?: string
  scheduleType: ScheduleType
  // for "minutes" / "hours"
  intervalValue: number
  // "HH:MM" for "daily"
  timeOfDay: string
  enabled: boolean
  createdAt: number
  nextRun: number
  lastRun?: number
  lastStatus?: "running" | "success" | "error"
  lastError?: string
  lastSessionID?: string
  runCount: number
}

export type TaskInput = {
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

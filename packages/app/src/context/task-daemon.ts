/**
 * Client for the always-on task-scheduler daemon's control API.
 *
 * The daemon (packages/task-scheduler) owns the canonical task store and is the
 * sole executor of scheduled runs. When it is reachable, the web UI defers to it
 * so tasks fire even when no browser tab is open. When it is unreachable, the UI
 * falls back to browser-local scheduling.
 */

import type { Task, TaskInput } from "@/context/task-scheduler-types"

export type DaemonStatus = {
  ok: true
  service: string
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

/**
 * Derive the daemon's control URL from the active opencode server URL. The
 * daemon listens on its own port (default 5055) on the same host as the server.
 */
export function deriveDaemonUrl(serverUrl: string, port = 5055): string {
  try {
    const url = new URL(/^https?:\/\//.test(serverUrl) ? serverUrl : `http://${serverUrl}`)
    return `${url.protocol}//${url.hostname}:${port}`
  } catch {
    return `http://localhost:${port}`
  }
}

async function request<T>(url: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const timeout = init?.timeout ?? 8_000
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // ignore body parse failures
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export class TaskDaemonClient {
  constructor(private readonly baseUrl: string) {}

  get url(): string {
    return this.baseUrl
  }

  async status(timeout = 3_000): Promise<DaemonStatus | undefined> {
    try {
      return await request<DaemonStatus>(`${this.baseUrl}/status`, { timeout })
    } catch {
      return undefined
    }
  }

  async list(): Promise<Task[]> {
    const data = await request<{ tasks: Task[] }>(`${this.baseUrl}/tasks`)
    return data.tasks
  }

  async add(input: TaskInput): Promise<Task> {
    const data = await request<{ task: Task }>(`${this.baseUrl}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    })
    return data.task
  }

  async update(id: string, input: TaskInput): Promise<Task> {
    const data = await request<{ task: Task }>(`${this.baseUrl}/tasks/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
    return data.task
  }

  async remove(id: string): Promise<void> {
    await request<{ ok: true }>(`${this.baseUrl}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  async toggle(id: string, enabled: boolean): Promise<Task> {
    const data = await request<{ task: Task }>(`${this.baseUrl}/tasks/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
    return data.task
  }

  async runNow(id: string): Promise<Task> {
    const data = await request<{ task: Task }>(`${this.baseUrl}/tasks/${encodeURIComponent(id)}/run`, {
      method: "POST",
      timeout: 60_000,
    })
    return data.task
  }

  /** Non-destructive bulk import (upsert by id). Returns the full task list. */
  async sync(tasks: Task[]): Promise<Task[]> {
    const data = await request<{ tasks: Task[] }>(`${this.baseUrl}/tasks/sync`, {
      method: "POST",
      body: JSON.stringify({ tasks }),
      timeout: 15_000,
    })
    return data.tasks
  }
}

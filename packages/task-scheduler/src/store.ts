import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Task } from "./types"

/**
 * Resolve the directory where the task store lives. Follows the same XDG
 * convention opencode itself uses (`~/.config/opencode`), overridable via env
 * so the daemon and any tooling can agree on a location.
 */
export function storeDir(): string {
  const fromEnv = process.env["OPENCODE_TASKS_DIR"]
  if (fromEnv) return fromEnv
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config")
  return join(base, "opencode")
}

export function storePath(): string {
  const fromEnv = process.env["OPENCODE_TASKS_FILE"]
  if (fromEnv) return fromEnv
  return join(storeDir(), "tasks.json")
}

interface StoreShape {
  version: 1
  tasks: Task[]
}

/**
 * A tiny file-backed task store. All mutations are serialized through an async
 * write queue and persisted atomically (temp file + rename) so a crash mid-write
 * can never corrupt the store.
 */
export class TaskStore {
  private tasks: Task[] = []
  private readonly file: string
  private writing: Promise<void> = Promise.resolve()

  constructor(file: string = storePath()) {
    this.file = file
  }

  get path(): string {
    return this.file
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8")
      const parsed = JSON.parse(raw) as Partial<StoreShape> | Task[]
      const list = Array.isArray(parsed) ? parsed : (parsed.tasks ?? [])
      this.tasks = list.filter((t): t is Task => !!t && typeof t === "object" && typeof t.id === "string")
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.tasks = []
        return
      }
      // A malformed store should not take the daemon down; start empty but keep
      // the bad file around for inspection.
      console.error(`[store] failed to read ${this.file}:`, err)
      this.tasks = []
    }
  }

  all(): Task[] {
    return this.tasks.slice()
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /** Replace the entire task list (used by the bulk sync endpoint). */
  async replaceAll(tasks: Task[]): Promise<void> {
    this.tasks = tasks.slice()
    await this.persist()
  }

  async upsert(task: Task): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === task.id)
    if (index === -1) this.tasks.unshift(task)
    else this.tasks[index] = task
    await this.persist()
  }

  async patch(id: string, update: Partial<Task>): Promise<Task | undefined> {
    const index = this.tasks.findIndex((t) => t.id === id)
    if (index === -1) return undefined
    const next = { ...this.tasks[index], ...update } as Task
    this.tasks[index] = next
    await this.persist()
    return next
  }

  async remove(id: string): Promise<boolean> {
    const before = this.tasks.length
    this.tasks = this.tasks.filter((t) => t.id !== id)
    if (this.tasks.length === before) return false
    await this.persist()
    return true
  }

  /** Serialize writes so concurrent mutations cannot interleave on disk. */
  private persist(): Promise<void> {
    const snapshot: StoreShape = { version: 1, tasks: this.tasks.slice() }
    this.writing = this.writing.then(() => this.writeAtomic(snapshot)).catch((err) => {
      console.error(`[store] failed to persist ${this.file}:`, err)
    })
    return this.writing
  }

  private async writeAtomic(data: StoreShape): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8")
    await rename(tmp, this.file)
  }
}

import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { Select } from "@opencode-ai/ui/select"
import { getFilename } from "@opencode-ai/util/path"
import { useGlobalSync } from "@/context/global-sync"
import {
  useTaskScheduler,
  describeSchedule,
  type ScheduleType,
  type Task,
  type TaskInput,
} from "@/context/task-scheduler"

type FormState = {
  id?: string
  name: string
  directory: string
  prompt: string
  agent: string
  scheduleType: ScheduleType
  intervalValue: number
  timeOfDay: string
  enabled: boolean
}

const SCHEDULE_OPTIONS: { value: ScheduleType; label: string }[] = [
  { value: "minutes", label: "Every N minutes" },
  { value: "hours", label: "Every N hours" },
  { value: "daily", label: "Daily at a time" },
]

function emptyForm(directory: string): FormState {
  return {
    name: "",
    directory,
    prompt: "",
    agent: "",
    scheduleType: "hours",
    intervalValue: 1,
    timeOfDay: "09:00",
    enabled: true,
  }
}

function toInput(form: FormState): TaskInput {
  return {
    name: form.name,
    directory: form.directory,
    prompt: form.prompt,
    agent: form.agent || undefined,
    scheduleType: form.scheduleType,
    intervalValue: form.intervalValue,
    timeOfDay: form.timeOfDay,
    enabled: form.enabled,
  }
}

function fromTask(task: Task): FormState {
  return {
    id: task.id,
    name: task.name,
    directory: task.directory,
    prompt: task.prompt,
    agent: task.agent ?? "",
    scheduleType: task.scheduleType,
    intervalValue: task.intervalValue,
    timeOfDay: task.timeOfDay,
    enabled: task.enabled,
  }
}

export default function Tasks() {
  const scheduler = useTaskScheduler()
  const globalSync = useGlobalSync()

  const projects = createMemo(() =>
    globalSync.data.project
      .filter((p) => !!p.worktree)
      .slice()
      .sort((a, b) => (a.name || getFilename(a.worktree)).localeCompare(b.name || getFilename(b.worktree))),
  )

  const homedir = createMemo(() => globalSync.data.path.home)
  const shortDir = (dir: string) => (homedir() ? dir.replace(homedir(), "~") : dir)
  const projectLabel = (dir: string) => {
    const project = projects().find((p) => p.worktree === dir)
    return project?.name || getFilename(dir) || dir
  }

  const defaultDirectory = createMemo(() => projects()[0]?.worktree ?? "")

  const [form, setForm] = createStore<FormState>(emptyForm(defaultDirectory()))
  const [editing, setEditing] = createSignal<"new" | "edit" | null>(null)
  const [error, setError] = createSignal<string | undefined>()

  const agents = createMemo(() => (form.directory ? scheduler.agentsFor(form.directory) : []))

  function openNew() {
    setError(undefined)
    setForm(emptyForm(defaultDirectory()))
    setEditing("new")
  }

  function openEdit(task: Task) {
    setError(undefined)
    setForm(fromTask(task))
    setEditing("edit")
  }

  function closeForm() {
    setEditing(null)
    setError(undefined)
  }

  function save() {
    if (!form.directory) {
      setError("Choose a project for this task.")
      return
    }
    if (!form.prompt.trim()) {
      setError("Enter a prompt for the agent to run.")
      return
    }
    if (form.scheduleType !== "daily" && (!form.intervalValue || form.intervalValue < 1)) {
      setError("Interval must be at least 1.")
      return
    }

    const input = toInput(form)
    if (editing() === "edit" && form.id) {
      scheduler.update(form.id, input)
    } else {
      scheduler.add(input)
    }
    closeForm()
  }

  const nextRunLabel = (task: Task) => {
    if (!task.enabled) return "Paused"
    const dt = DateTime.fromMillis(task.nextRun)
    return `Runs ${dt.toRelative()}`
  }

  return (
    <div class="size-full overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-4 py-8 flex flex-col gap-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h1 class="text-16-medium text-text-strong">Scheduled Tasks</h1>
            <p class="text-12-regular text-text-weak">
              Run a prompt on a schedule. Each run opens a new session in the chosen project.
            </p>
          </div>
          <Show when={editing() === null}>
            <Button variant="primary" icon="plus-small" class="px-3 shrink-0" onClick={openNew}>
              New task
            </Button>
          </Show>
        </div>

        <Show when={!scheduler.hasModel()}>
          <div
            data-component="card"
            data-variant="warning"
            class="flex items-center gap-3 px-4 py-3 text-12-regular"
          >
            <Icon name="circle-ban-sign" size="small" />
            <span>No connected model found. Connect a provider so scheduled tasks can run.</span>
          </div>
        </Show>

        <Show
          when={scheduler.connected}
          fallback={
            <div
              data-component="card"
              data-variant="info"
              class="flex items-start gap-3 px-4 py-3 text-12-regular text-text-weak"
            >
              <Icon name="eye" size="small" />
              <span>
                The background scheduler isn't running, so tasks only fire while this OpenCode tab is open. Start the
                task-scheduler daemon to run tasks 24/7.
              </span>
            </div>
          }
        >
          <div
            data-component="card"
            data-variant="info"
            class="flex items-start gap-3 px-4 py-3 text-12-regular text-text-weak"
          >
            <Icon name="circle-check" size="small" />
            <span>
              Background scheduler connected. Tasks run automatically on the server even when this tab is closed.
            </span>
          </div>
        </Show>

        <Show when={editing() !== null}>
          <TaskForm
            form={form}
            setForm={setForm}
            projects={projects()}
            agents={agents()}
            shortDir={shortDir}
            projectLabel={projectLabel}
            error={error()}
            mode={editing() === "edit" ? "edit" : "new"}
            onCancel={closeForm}
            onSave={save}
          />
        </Show>

        <Switch>
          <Match when={scheduler.tasks.length === 0 && editing() === null}>
            <div class="mt-10 flex flex-col items-center gap-3 text-center">
              <Icon name="task" size="large" />
              <div class="flex flex-col gap-1">
                <div class="text-14-medium text-text-strong">No scheduled tasks yet</div>
                <div class="text-12-regular text-text-weak">
                  Create a task to run a prompt automatically on a schedule.
                </div>
              </div>
              <Button class="px-3 mt-1" icon="plus-small" onClick={openNew}>
                New task
              </Button>
            </div>
          </Match>
          <Match when={scheduler.tasks.length > 0}>
            <ul class="flex flex-col gap-3">
              <For each={scheduler.tasks}>
                {(task) => (
                  <li
                    data-component="card"
                    class="flex flex-col gap-3 px-4 py-3"
                    classList={{ "opacity-60": !task.enabled }}
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="flex flex-col gap-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-14-medium text-text-strong truncate">{task.name}</span>
                          <StatusBadge task={task} />
                        </div>
                        <div class="text-12-regular text-text-weak truncate">
                          {projectLabel(task.directory)} · {describeSchedule(task)}
                        </div>
                      </div>
                      <Toggle
                        checked={task.enabled}
                        onChange={(checked) => scheduler.toggle(task.id, checked)}
                        hideLabel
                      >
                        Enabled
                      </Toggle>
                    </div>

                    <p class="text-12-regular text-text-base line-clamp-2 whitespace-pre-wrap break-words">
                      {task.prompt}
                    </p>

                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 text-12-regular text-text-weak min-w-0">
                        <Icon name="task" size="small" />
                        <span class="truncate">
                          {nextRunLabel(task)}
                          <Show when={task.lastRun}>
                            {" · "}
                            Last {DateTime.fromMillis(task.lastRun!).toRelative()}
                          </Show>
                          <Show when={task.runCount > 0}>
                            {" · "}
                            {task.runCount} run{task.runCount === 1 ? "" : "s"}
                          </Show>
                        </span>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <Button
                          size="small"
                          icon="enter"
                          class="px-2"
                          onClick={() => scheduler.runNow(task.id)}
                        >
                          Run now
                        </Button>
                        <IconButton
                          icon="pencil-line"
                          variant="ghost"
                          onClick={() => openEdit(task)}
                          aria-label="Edit task"
                        />
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          onClick={() => scheduler.remove(task.id)}
                          aria-label="Delete task"
                        />
                      </div>
                    </div>

                    <Show when={task.lastStatus === "error" && task.lastError}>
                      <div class="text-12-regular text-text-critical-base">{task.lastError}</div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function StatusBadge(props: { task: Task }) {
  const label = createMemo(() => {
    if (props.task.lastStatus === "running") return "Running"
    if (props.task.lastStatus === "error") return "Error"
    if (props.task.lastStatus === "success") return "OK"
    return undefined
  })
  return (
    <Show when={label()}>
      <span
        class="shrink-0 rounded px-1.5 py-0.5 text-11-medium"
        classList={{
          "bg-background-element text-text-weak": props.task.lastStatus === "success",
          "bg-background-element text-text-base": props.task.lastStatus === "running",
          "text-text-critical-base": props.task.lastStatus === "error",
        }}
      >
        {label()}
      </span>
    </Show>
  )
}

type ProjectLike = { worktree: string; name?: string }

function TaskForm(props: {
  form: FormState
  setForm: (key: keyof FormState, value: FormState[keyof FormState]) => void
  projects: ProjectLike[]
  agents: { name: string }[]
  shortDir: (dir: string) => string
  projectLabel: (dir: string) => string
  error?: string
  mode: "new" | "edit"
  onCancel: () => void
  onSave: () => void
}) {
  const directories = createMemo(() => props.projects.map((p) => p.worktree))
  const DEFAULT_AGENT = "__default__"
  const agentOptions = createMemo(() => [DEFAULT_AGENT, ...props.agents.map((a) => a.name)])

  return (
    <div data-component="card" class="flex flex-col gap-4 px-4 py-4">
      <div class="text-14-medium text-text-strong">{props.mode === "edit" ? "Edit task" : "New task"}</div>

      <TextField
        label="Name"
        placeholder="Nightly dependency check"
        value={props.form.name}
        onChange={(value) => props.setForm("name", value)}
      />

      <div class="flex flex-col gap-1.5">
        <label class="text-12-medium text-text-strong">Project</label>
        <Show
          when={directories().length > 0}
          fallback={<div class="text-12-regular text-text-weak">Open a project first to schedule a task.</div>}
        >
          <Select
            options={directories()}
            current={props.form.directory}
            value={(dir) => dir}
            label={(dir) => props.projectLabel(dir)}
            onSelect={(dir) => dir !== undefined && props.setForm("directory", dir)}
            class="justify-between w-full"
          />
        </Show>
        <Show when={props.form.directory}>
          <span class="text-11-regular text-text-weak truncate">{props.shortDir(props.form.directory)}</span>
        </Show>
      </div>

      <TextField
        label="Prompt"
        placeholder="Review open PRs and summarize what needs attention."
        value={props.form.prompt}
        onChange={(value) => props.setForm("prompt", value)}
        multiline
      />

      <div class="flex flex-col gap-1.5">
        <label class="text-12-medium text-text-strong">Agent</label>
        <Select
          options={agentOptions()}
          current={props.form.agent || DEFAULT_AGENT}
          value={(name) => name}
          label={(name) => (name === DEFAULT_AGENT ? "Default" : name)}
          onSelect={(name) => name !== undefined && props.setForm("agent", name === DEFAULT_AGENT ? "" : name)}
          class="justify-between w-full"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-12-medium text-text-strong">Schedule</label>
        <div class="flex items-center gap-2 flex-wrap">
          <Select
            options={SCHEDULE_OPTIONS.map((o) => o.value)}
            current={props.form.scheduleType}
            value={(v) => v}
            label={(v) => SCHEDULE_OPTIONS.find((o) => o.value === v)?.label ?? v}
            onSelect={(v) => v !== undefined && props.setForm("scheduleType", v)}
          />
          <Show when={props.form.scheduleType !== "daily"}>
            <input
              data-component="input"
              type="number"
              min="1"
              class="h-8 w-20 rounded border border-border-weak-base bg-background-base px-2 text-14-regular"
              value={props.form.intervalValue}
              onInput={(e) => props.setForm("intervalValue", Math.max(1, Number(e.currentTarget.value) || 1))}
            />
            <span class="text-12-regular text-text-weak">
              {props.form.scheduleType === "minutes" ? "minutes" : "hours"}
            </span>
          </Show>
          <Show when={props.form.scheduleType === "daily"}>
            <input
              data-component="input"
              type="time"
              class="h-8 rounded border border-border-weak-base bg-background-base px-2 text-14-regular"
              value={props.form.timeOfDay}
              onInput={(e) => props.setForm("timeOfDay", e.currentTarget.value || "09:00")}
            />
          </Show>
        </div>
      </div>

      <Toggle
        checked={props.form.enabled}
        onChange={(checked) => props.setForm("enabled", checked)}
        description="When enabled, this task runs automatically on its schedule."
      >
        Enabled
      </Toggle>

      <Show when={props.error}>
        <div class="text-12-regular text-text-critical-base">{props.error}</div>
      </Show>

      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={props.onSave}>
          {props.mode === "edit" ? "Save changes" : "Create task"}
        </Button>
      </div>
    </div>
  )
}

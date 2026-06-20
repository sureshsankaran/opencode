/**
 * Minimal HTTP client for the running `opencode serve` instance. Uses raw fetch
 * so the daemon has zero runtime dependencies and stays robust as a long-lived
 * service.
 */

export interface ModelRef {
  providerID: string
  modelID: string
}

interface ProviderInfo {
  id: string
  models: Record<string, unknown>
}

interface ProviderListResponse {
  all: ProviderInfo[]
  default: Record<string, string>
  connected: string[]
}

/** Preferred model for automation tasks. Matches the web UI default. */
export const AUTOMATION_DEFAULT_MODEL: ModelRef = {
  providerID: "github-copilot",
  modelID: "claude-opus-4.6",
}

export class OpencodeClient {
  private readonly baseUrl: string
  private readonly auth?: string

  constructor(baseUrl: string, opts: { username?: string; password?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "")
    if (opts.password) {
      const user = opts.username ?? "opencode"
      this.auth = "Basic " + Buffer.from(`${user}:${opts.password}`).toString("base64")
    }
  }

  get url(): string {
    return this.baseUrl
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    if (this.auth) headers["Authorization"] = this.auth
    return headers
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/config/providers`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async providers(): Promise<ProviderListResponse | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/provider`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return undefined
      return (await res.json()) as ProviderListResponse
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a usable model. Prefers an explicit override, then the automation
   * default (Claude Opus 4.6), then any connected provider's default, then any
   * connected model at all — mirroring the browser scheduler's fallback chain.
   */
  async resolveModel(override?: string): Promise<ModelRef | undefined> {
    const providers = await this.providers()
    if (!providers) {
      // If we cannot read providers, fall back to the override (if any) or the
      // automation default and let the server validate it.
      if (override) return parseModel(override)
      return { ...AUTOMATION_DEFAULT_MODEL }
    }

    const valid = (providerID: string, modelID: string) => {
      if (!providers.connected.includes(providerID)) return false
      const provider = providers.all.find((p) => p.id === providerID)
      return !!provider && provider.models[modelID] !== undefined
    }

    if (override) {
      const parsed = parseModel(override)
      if (parsed && valid(parsed.providerID, parsed.modelID)) return parsed
    }

    if (valid(AUTOMATION_DEFAULT_MODEL.providerID, AUTOMATION_DEFAULT_MODEL.modelID)) {
      return { ...AUTOMATION_DEFAULT_MODEL }
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

  /** Create a new session scoped to `directory`. Returns the session id. */
  async createSession(directory: string, title: string): Promise<string> {
    const url = `${this.baseUrl}/session?directory=${encodeURIComponent(directory)}`
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`session.create failed (${res.status}): ${await safeText(res)}`)
    }
    const data = (await res.json()) as { id?: string }
    if (!data?.id) throw new Error("session.create returned no id")
    return data.id
  }

  /** Fire a fire-and-forget prompt into an existing session. */
  async promptAsync(args: {
    sessionID: string
    directory: string
    prompt: string
    model?: ModelRef
    agent?: string
  }): Promise<void> {
    const url = `${this.baseUrl}/session/${encodeURIComponent(args.sessionID)}/prompt_async?directory=${encodeURIComponent(args.directory)}`
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: args.prompt }],
    }
    if (args.model) body.model = args.model
    if (args.agent) body.agent = args.agent

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    // prompt_async returns 204 No Content on success.
    if (!res.ok && res.status !== 204) {
      throw new Error(`session.prompt_async failed (${res.status}): ${await safeText(res)}`)
    }
  }
}

export function parseModel(value: string): ModelRef | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return "<no body>"
  }
}

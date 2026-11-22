/**
 * One small client for every OpenAI-compatible chat API: Groq, Google Gemini, OpenRouter, a local Ollama.
 * Switching provider = changing AI_PROVIDERS in .env.local, no code change.
 *
 *   AI_PROVIDERS="groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b"
 *   (Groq retired llama-3.3-70b-versatile and llama-3.1-8b-instant on 2026-08-16; check console.groq.com/docs/models)
 *
 * The list is a FALLBACK CHAIN: the first entry that is not cooling down / out of budget is used.
 * A 429 or 5xx moves on to the next entry, so a free tier running dry never stops the pipeline.
 * Model names change often - check the provider's current list if a name stops working.
 */

import type { StateStore } from "../state/store"

export type ProviderEntry = { provider: string; model: string; baseUrl: string; apiKey?: string }

const BASES: Record<string, { baseUrl: string; keyEnv?: string }> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
}

export function loadChain(env: Record<string, string | undefined> = process.env): ProviderEntry[] {
  const raw = (env.AI_PROVIDERS || "").trim()
  if (!raw) return []
  const out: ProviderEntry[] = []
  for (const item of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const i = item.indexOf(":")
    if (i < 1) continue
    const provider = item.slice(0, i).toLowerCase()
    const model = item.slice(i + 1)
    const base = BASES[provider]
    if (!base || !model) continue
    const apiKey = base.keyEnv ? env[base.keyEnv] : undefined
    if (base.keyEnv && !apiKey) continue // no key = not usable, skip silently
    out.push({ provider, model, baseUrl: (env[`${provider.toUpperCase()}_BASE_URL`] || base.baseUrl).replace(/\/+$/, ""), apiKey })
  }
  return out
}

/** Models that reason before answering (OpenAI gpt-oss, Qwen3, DeepSeek R1...). */
export const isReasoningModel = (model: string) => /gpt-oss|qwen3|deepseek-r1|(^|\/)o\d|reason/i.test(model)

export type ChatResult = { json: unknown; text: string; used: string; tokens: number }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export class AiUnavailableError extends Error {}

/** Why a model is paused: its daily quota is used up, a per-minute limit, our own daily budget, or a server error. */
export type LimitKind = "daily" | "minute" | "budget" | "error"
type State = { cooldownUntil: number; day: string; tokensToday: number; limit?: LimitKind }

/** One model's state for the UI (toasts) and reports. */
export type AiUsage = { entry: string; tokensToday: number; cooldownSeconds: number; limit?: LimitKind }

/**
 * Read a 429/5xx: is it the DAILY quota (tokens/requests per day) or a short per-minute limit, and when does it lift?
 * Groq says e.g. "Rate limit reached ... on tokens per day (TPD) ... Please try again in 7m12.5s."
 */
export function readLimit(status: number, body: string, retryAfterHeader: string | null): { kind: LimitKind; waitMs?: number } {
  const b = String(body || "")
  const kind: LimitKind = status >= 500 ? "error" : /per day|\bTPD\b|\bRPD\b|daily|quota/i.test(b) ? "daily" : "minute"
  const m = b.match(/try again in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i)
  let waitMs: number | undefined
  if (m && (m[1] || m[2] || m[3])) waitMs = ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000
  const ra = Number(retryAfterHeader)
  if (!waitMs && Number.isFinite(ra) && ra > 0) waitMs = ra * 1000
  return { kind, waitMs }
}

/** Strip ```json fences and take the outermost {...}. */
export function parseJsonLoose(text: string): unknown {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}")
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1))
    throw new Error("not JSON")
  }
}

export class AiClient {
  private state = new Map<string, State>()

  constructor(
    private chain: ProviderEntry[] = loadChain(),
    private opts: {
      fetch?: FetchLike
      now?: () => number
      timeoutMs?: number
      dailyTokenBudget?: number
      /** Shared store (Sheet state tab) so every serverless instance sees the same cooldowns and token counts. */
      store?: StateStore
    } = {}
  ) {}

  private storeKey = (e: ProviderEntry) => `ai:${this.key(e)}`
  private storeWarned = false

  private storeFailed(what: string, err: unknown) {
    // The store is best effort: a Sheets hiccup must never stop listing. Warn once per instance, no details that could hold secrets.
    if (!this.storeWarned) console.warn(`AI state store ${what} failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`)
    this.storeWarned = true
  }

  /** Pull the shared state (one read). Remote cooldowns/counters win if they are further along than ours. */
  async sync() {
    if (!this.opts.store || !this.chain.length) return
    try {
      const remote = await this.opts.store.getMany<State>(this.chain.map(this.storeKey))
      for (const e of this.chain) {
        const r = remote.get(this.storeKey(e))?.value
        if (!r) continue
        const local = this.st(e)
        if (r.cooldownUntil > local.cooldownUntil) {
          local.cooldownUntil = r.cooldownUntil
          local.limit = r.limit
        }
        if (r.day === local.day && r.tokensToday > local.tokensToday) local.tokensToday = r.tokensToday
      }
    } catch (err) {
      this.storeFailed("read", err)
    }
  }

  private async persist(e: ProviderEntry) {
    if (!this.opts.store) return
    try {
      await this.opts.store.set(this.storeKey(e), this.st(e))
    } catch (err) {
      this.storeFailed("write", err)
    }
  }

  /** usage() after pulling the shared state: what all instances used today. */
  async sharedUsage() {
    await this.sync()
    return this.usage()
  }

  get available() {
    return this.chain.length > 0
  }

  private key = (e: ProviderEntry) => `${e.provider}:${e.model}`
  private now = () => (this.opts.now ? this.opts.now() : Date.now())
  private today = () => new Date(this.now()).toISOString().slice(0, 10)

  private st(e: ProviderEntry): State {
    let s = this.state.get(this.key(e))
    if (!s || s.day !== this.today()) {
      s = { cooldownUntil: s?.cooldownUntil ?? 0, day: this.today(), tokensToday: 0, limit: s?.limit === "budget" ? undefined : s?.limit }
      this.state.set(this.key(e), s)
    }
    return s
  }

  /** For the UI / daily report: what has been used today per chain entry. */
  usage(): AiUsage[] {
    const budget = this.opts.dailyTokenBudget ?? Number(process.env.AI_DAILY_TOKEN_BUDGET || 0)
    return this.chain.map(e => {
      const s = this.st(e)
      const cooldownSeconds = Math.max(0, Math.ceil((s.cooldownUntil - this.now()) / 1000))
      const overBudget = budget > 0 && s.tokensToday >= budget
      const limit: LimitKind | undefined = overBudget ? "budget" : cooldownSeconds > 0 ? s.limit : undefined
      return { entry: this.key(e), tokensToday: s.tokensToday, cooldownSeconds, ...(limit ? { limit } : {}) }
    })
  }

  /** Ask for a JSON object. Tries each chain entry in order; throws AiUnavailableError if all fail. */
  async chatJson(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<ChatResult> {
    if (!this.chain.length) throw new AiUnavailableError("No AI provider configured (set AI_PROVIDERS and an API key in .env.local)")
    const errors: string[] = []
    const budget = this.opts.dailyTokenBudget ?? Number(process.env.AI_DAILY_TOKEN_BUDGET || 0)
    await this.sync()

    for (const e of this.chain) {
      const s = this.st(e)
      if (s.cooldownUntil > this.now()) { errors.push(`${this.key(e)}: cooling down`); continue }
      if (budget > 0 && s.tokensToday >= budget) { errors.push(`${this.key(e)}: daily token budget used`); continue }

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const f: FetchLike = this.opts.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>)
          const res = await f(`${e.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(e.apiKey ? { Authorization: `Bearer ${e.apiKey}` } : {}) },
            body: JSON.stringify({
              model: e.model,
              temperature: 0,
              // Reasoning models (gpt-oss, qwen3...) think before answering and that counts against max_tokens:
              // ask for low effort and leave room, or the JSON answer gets cut off.
              max_tokens: isReasoningModel(e.model) ? Math.max(opts.maxTokens ?? 1200, 2500) : (opts.maxTokens ?? 1200),
              ...(isReasoningModel(e.model) && e.provider === "groq" ? { reasoning_effort: "low" } : {}),
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: system },
                { role: "user", content: attempt ? `${user}\n\nReturn ONLY one valid JSON object.` : user },
              ],
            }),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
          })
          const body = await res.text()
          if (res.status === 429 || res.status >= 500) {
            const lim = readLimit(res.status, body, res.headers.get("retry-after"))
            // daily quota with no hint: wait until the next UTC day (when the day counters restart)
            const untilTomorrow = Date.UTC(new Date(this.now()).getUTCFullYear(), new Date(this.now()).getUTCMonth(), new Date(this.now()).getUTCDate() + 1) - this.now()
            s.cooldownUntil = this.now() + (lim.waitMs ?? (lim.kind === "daily" ? untilTomorrow : 60_000))
            s.limit = lim.kind
            await this.persist(e)
            errors.push(`${this.key(e)}: ${lim.kind === "daily" ? "out of tokens for today" : lim.kind === "minute" ? "rate limit (per minute)" : `HTTP ${res.status}`}`)
            break // next chain entry
          }
          if (!res.ok) {
            const gone = (res.status === 404 || res.status === 400) && /does not exist|decommissioned|deprecated|not found|no access/i.test(body)
            errors.push(gone ? `${this.key(e)}: this model is not available any more (retired or renamed) - update AI_PROVIDERS in Vercel` : `${this.key(e)}: HTTP ${res.status} ${body.slice(0, 120)}`)
            break
          }
          const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } }
          const text = data.choices?.[0]?.message?.content ?? ""
          s.tokensToday += data.usage?.total_tokens ?? Math.ceil((system.length + user.length + text.length) / 4)
          await this.persist(e)
          try {
            return { json: parseJsonLoose(text), text, used: this.key(e), tokens: data.usage?.total_tokens ?? 0 }
          } catch {
            errors.push(`${this.key(e)}: invalid JSON`)
            continue // one repair retry on the same entry
          }
        } catch (err) {
          errors.push(`${this.key(e)}: ${err instanceof Error ? err.message : String(err)}`)
          break
        }
      }
    }
    throw new AiUnavailableError(`All AI providers failed: ${errors.join("; ")}`)
  }
}

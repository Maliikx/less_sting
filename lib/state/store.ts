/**
 * Small persistent key/value store for state that must survive between serverless requests and be shared
 * by all instances (AI cooldowns and daily token counts now; dead-check results and the cron cursor later).
 *
 * Values are JSON. Writes are last-write-wins: two instances writing the same key at the same moment can
 * lose one update. That is acceptable for what is stored here (cooldowns, approximate token counters);
 * do not use it for anything that needs a lock.
 */

export type StateEntry<T = unknown> = { value: T; updatedAt: number; expiresAt?: number }

export interface StateStore {
  /** null when missing or expired. */
  get<T = unknown>(key: string): Promise<StateEntry<T> | null>
  /** Same as get for several keys with one read. Missing/expired keys are absent from the map. */
  getMany<T = unknown>(keys: string[]): Promise<Map<string, StateEntry<T>>>
  set<T = unknown>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>
  /** Several keys with as few writes as possible. */
  setMany<T = unknown>(entries: { key: string; value: T; ttlMs?: number }[]): Promise<void>
}

/** In-memory store: tests, local dev without Google credentials. NOT shared between serverless instances. */
export class MemoryStateStore implements StateStore {
  private data = new Map<string, StateEntry>()
  constructor(private now: () => number = Date.now) {}

  async get<T>(key: string) {
    return (await this.getMany<T>([key])).get(key) ?? null
  }

  async getMany<T>(keys: string[]) {
    const out = new Map<string, StateEntry<T>>()
    for (const k of keys) {
      const e = this.data.get(k)
      if (e && !(e.expiresAt && e.expiresAt <= this.now())) out.set(k, structuredClone(e) as StateEntry<T>)
    }
    return out
  }

  async set<T>(key: string, value: T, opts: { ttlMs?: number } = {}) {
    await this.setMany([{ key, value, ttlMs: opts.ttlMs }])
  }

  async setMany<T>(entries: { key: string; value: T; ttlMs?: number }[]) {
    const now = this.now()
    for (const e of entries) {
      this.data.set(e.key, { value: structuredClone(e.value), updatedAt: now, ...(e.ttlMs ? { expiresAt: now + e.ttlMs } : {}) })
    }
  }
}

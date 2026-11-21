import type { StateEntry, StateStore } from "./store"
import { ensureOwnTab, quoteTab as quote } from "./ownTab"

/**
 * StateStore kept in its OWN tab of the Google Sheet (default name LS_STATE, env STATE_SHEET_TAB).
 *
 *   A KEY | B VALUE (JSON) | C UPDATED_AT (ms) | D EXPIRES_AT (ms, empty = never)
 *
 * Safety (user rule: never edit the existing tabs):
 *  - every read and write is limited to this tab's range;
 *  - the tab is created if missing; if a tab with that name exists but its header row is not ours, the store
 *    refuses to use it instead of writing into someone else's tab.
 * Rows are overwritten in place for an existing key; new keys are appended. No rows are deleted.
 */

export const STATE_HEADERS = ["KEY", "VALUE", "UPDATED_AT", "EXPIRES_AT"]

/** The few Sheets operations the store needs. Real implementation below; tests use a fake. */
export interface SheetsApi {
  /** Tab names in the spreadsheet. */
  listTabs(): Promise<string[]>
  addTab(name: string): Promise<void>
  getValues(range: string): Promise<string[][]>
  /** Several ranges in one call. */
  batchUpdate(data: { range: string; values: (string | number)[][] }[]): Promise<void>
  append(range: string, values: (string | number)[][]): Promise<void>
}

export { TabConflictError as StateTabConflictError } from "./ownTab"


type Row = { rowNumber: number; key: string; entry: StateEntry }

export class SheetStateStore implements StateStore {
  private ready: Promise<void> | null = null

  constructor(
    private api: SheetsApi,
    private tab = "LS_STATE",
    private now: () => number = Date.now
  ) {}

  private range = (a1: string) => `${quote(this.tab)}!${a1}`

  /** Create the tab (with headers) if needed; refuse a same-named tab that isn't ours. Once per instance. */
  private ensureTab() {
    if (!this.ready) {
      this.ready = ensureOwnTab(this.api, this.tab, STATE_HEADERS, "Set STATE_SHEET_TAB to another name.").catch(e => {
        this.ready = null // retry next time (e.g. a network error)
        throw e
      })
    }
    return this.ready
  }

  private async readRows(): Promise<Row[]> {
    await this.ensureTab()
    const values = await this.api.getValues(this.range("A2:D"))
    const rows: Row[] = []
    values.forEach((r, i) => {
      const key = String(r[0] ?? "").trim()
      if (!key) return
      let value: unknown
      try {
        value = JSON.parse(String(r[1] ?? "null"))
      } catch {
        return // a hand-edited bad cell is ignored, not fatal
      }
      const updatedAt = Number(r[2]) || 0
      const expiresAt = Number(r[3]) || undefined
      rows.push({ rowNumber: i + 2, key, entry: { value, updatedAt, ...(expiresAt ? { expiresAt } : {}) } })
    })
    return rows
  }

  /** Latest row per key (two instances may have appended the same new key at once). */
  private static latest(rows: Row[]) {
    const m = new Map<string, Row>()
    for (const r of rows) {
      const cur = m.get(r.key)
      if (!cur || r.entry.updatedAt >= cur.entry.updatedAt) m.set(r.key, r)
    }
    return m
  }

  async get<T>(key: string) {
    return (await this.getMany<T>([key])).get(key) ?? null
  }

  async getMany<T>(keys: string[]) {
    const latest = SheetStateStore.latest(await this.readRows())
    const out = new Map<string, StateEntry<T>>()
    const now = this.now()
    for (const k of keys) {
      const r = latest.get(k)
      if (r && !(r.entry.expiresAt && r.entry.expiresAt <= now)) out.set(k, r.entry as StateEntry<T>)
    }
    return out
  }

  async set<T>(key: string, value: T, opts: { ttlMs?: number } = {}) {
    await this.setMany([{ key, value, ttlMs: opts.ttlMs }])
  }

  async setMany<T>(entries: { key: string; value: T; ttlMs?: number }[]) {
    if (!entries.length) return
    const latest = SheetStateStore.latest(await this.readRows())
    const now = this.now()
    const updates: { range: string; values: (string | number)[][] }[] = []
    const appends: (string | number)[][] = []
    for (const e of entries) {
      const json = JSON.stringify(e.value)
      if (json.length > 45_000) throw new Error(`State value for "${e.key}" is too large for one cell`)
      const row = [e.key, json, now, e.ttlMs ? now + e.ttlMs : ""]
      const existing = latest.get(e.key)
      if (existing) updates.push({ range: this.range(`A${existing.rowNumber}:D${existing.rowNumber}`), values: [row] })
      else appends.push(row)
    }
    if (updates.length) await this.api.batchUpdate(updates)
    if (appends.length) await this.api.append(this.range("A:D"), appends)
  }
}

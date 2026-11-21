import { sheets } from "../sheets"
import { SheetStateStore, type SheetsApi } from "./sheetStore"
import { MemoryStateStore, type StateStore } from "./store"

export * from "./store"
export { SheetStateStore, StateTabConflictError, STATE_HEADERS, type SheetsApi } from "./sheetStore"

/** googleapis wrapper. Only ever called with ranges inside the state tab (see SheetStateStore). */
export function googleSheetsApi(spreadsheetId: string): SheetsApi {
  return {
    async listTabs() {
      const r = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" })
      return (r.data.sheets || []).map(s => s.properties?.title || "").filter(Boolean)
    },
    async addTab(title) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { columnCount: 4 } } } }] } })
    },
    async getValues(range) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range })
      return (r.data.values || []) as string[][]
    },
    async batchUpdate(data) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data } })
    },
    async append(range, values) {
      await sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values } })
    },
  }
}

/**
 * The store for this server: the sheet's state tab when Google is configured, otherwise in-memory
 * (local dev only; not shared between instances). Reused within one instance.
 */
export function getStateStore(env: Record<string, string | undefined> = process.env): StateStore {
  const g = globalThis as unknown as { __lsState?: StateStore }
  if (g.__lsState) return g.__lsState
  const id = env.GOOGLE_SHEET_ID?.trim()
  const ok = id && env.GOOGLE_CLIENT_EMAIL?.trim() && env.GOOGLE_PRIVATE_KEY?.trim()
  g.__lsState = ok ? new SheetStateStore(googleSheetsApi(id!), env.STATE_SHEET_TAB?.trim() || "LS_STATE") : new MemoryStateStore()
  return g.__lsState
}

import type { SheetsApi } from "./sheetStore"

/** A tab with this name exists but was not created by the app (header differs or it holds other data). */
export class TabConflictError extends Error {}

export const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`
const lastCol = (n: number) => String.fromCharCode(64 + n)

/**
 * Make sure the app's OWN tab exists with exactly these headers in row 1.
 *  - missing -> create it and write the headers
 *  - present and empty -> claim it (write headers)
 *  - present with our headers -> use it
 *  - anything else -> TabConflictError, and NOTHING is written (user rule: never edit the existing tabs)
 */
export async function ensureOwnTab(api: SheetsApi, tab: string, headers: string[], hint: string) {
  const q = quoteTab(tab)
  const headRange = `${q}!A1:${lastCol(headers.length)}1`
  const conflict = () => new TabConflictError(`The sheet already has a tab named "${tab}" that was not created by this app. It was left untouched. ${hint}`)
  const tabs = await api.listTabs()
  if (!tabs.includes(tab)) {
    await api.addTab(tab)
    await api.batchUpdate([{ range: headRange, values: [headers] }])
    return
  }
  const head = (await api.getValues(headRange))[0] || []
  if (head.every(c => !String(c ?? "").trim())) {
    const any = await api.getValues(`${q}!A1:Z20`)
    if (any.some(r => r.some(c => String(c ?? "").trim()))) throw conflict()
    await api.batchUpdate([{ range: headRange, values: [headers] }])
    return
  }
  if (headers.some((h, i) => String(head[i] ?? "").trim() !== h)) throw conflict()
}

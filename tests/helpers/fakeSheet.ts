import type { SheetsApi } from "../../lib/state/sheetStore"

/* ------------------------------------------------------------ fake spreadsheet */

/** In-memory spreadsheet: tab -> rows. Records every range used so tests can prove other tabs are never touched. */
export function fakeSpreadsheet(initial: Record<string, string[][]> = { Sheet1: [["LINK", "PRICE"], ["https://x", "10"]] }) {
  const tabs: Record<string, string[][]> = structuredClone(initial)
  const touched: string[] = []
  const parse = (range: string) => {
    const m = range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/)
    if (!m) throw new Error(`bad range ${range}`)
    const tab = m[1].replace(/''/g, "'")
    const col = (c: string) => c.charCodeAt(0) - 65
    return { tab, c1: col(m[2]), r1: m[3] ? Number(m[3]) : 1, c2: col(m[4] || m[2]), r2: m[5] ? Number(m[5]) : Infinity }
  }
  let ops = 0
  const api: SheetsApi = {
    async listTabs() { ops++; return Object.keys(tabs) },
    async addTab(name) { ops++; touched.push(`add:${name}`); tabs[name] = [] },
    async getValues(range) {
      ops++
      touched.push(range)
      const { tab, c1, r1, c2, r2 } = parse(range)
      const rows = tabs[tab] || []
      const out: string[][] = []
      for (let r = r1; r <= Math.min(r2, rows.length); r++) out.push((rows[r - 1] || []).slice(c1, c2 + 1))
      while (out.length && out[out.length - 1].every(c => !c)) out.pop()
      return out
    },
    async batchUpdate(data) {
      ops++
      for (const d of data) {
        touched.push(d.range)
        const { tab, c1, r1 } = parse(d.range)
        const rows = (tabs[tab] ||= [])
        d.values.forEach((vals, i) => {
          const row = (rows[r1 - 1 + i] ||= [])
          vals.forEach((v, j) => (row[c1 + j] = String(v)))
        })
      }
    },
    async append(range, values) {
      ops++
      touched.push(range)
      const { tab } = parse(range)
      const rows = (tabs[tab] ||= [])
      for (const v of values) rows.push(v.map(String))
    },
  }
  return { api, tabs, touched, ops: () => ops }
}


import { google } from "googleapis"

/**
 * One place for everything Google Sheets.
 *
 * Sheet layout (row 1 = headers, data starts on row 2):
 *
 *   A LINK | B PRICE | C EMPLOYEE | D TITLE | E NOTE | F CREATED_AT        <- original columns (unchanged)
 *   G GB_OFFER_ID | H GB_STATUS | I EXTERNAL_ID | J GB_PRICE_EUR | K GAME | L GB_UPDATED_AT   <- new GameBoost columns
 *
 * The first six columns are written exactly as before so existing formulas,
 * filters and the daily counter keep working.
 */

export const COL = {
  LINK: 0,
  PRICE: 1,
  EMPLOYEE: 2,
  TITLE: 3,
  NOTE: 4,
  CREATED_AT: 5,
  GB_OFFER_ID: 6,
  GB_STATUS: 7,
  EXTERNAL_ID: 8,
  GB_PRICE_EUR: 9,
  GAME: 10,
  GB_UPDATED_AT: 11,
} as const

export const HEADERS = [
  "LINK",
  "PRICE",
  "EMPLOYEE",
  "TITLE",
  "NOTE",
  "CREATED_AT",
  "GB_OFFER_ID",
  "GB_STATUS",
  "EXTERNAL_ID",
  "GB_PRICE_EUR",
  "GAME",
  "GB_UPDATED_AT",
]

const LAST_COL = "L"
const COL_LETTERS = "ABCDEFGHIJKL"

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
})

export const sheets = google.sheets({ version: "v4", auth })

const spreadsheetId = () => process.env.GOOGLE_SHEET_ID

/** Optional tab name. Empty = first tab (the original behaviour). */
function r(range: string) {
  const tab = process.env.GOOGLE_SHEET_TAB?.trim()
  return tab ? `'${tab.replace(/'/g, "''")}'!${range}` : range
}

/* ------------------------------------------------------------ setup checks */

function checkEnv() {
  const missing = ["GOOGLE_SHEET_ID", "GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY"].filter(k => !process.env[k]?.trim())
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(", ")}`)
}

let columnsReady: Promise<void> | null = null

/**
 * The app now uses columns A-L. A sheet with fewer than 12 columns makes Google
 * reject every read ("exceeds grid limits"), so add the missing columns once.
 */
function ensureColumns() {
  checkEnv()
  if (!columnsReady) {
    columnsReady = (async () => {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId(),
        fields: "sheets.properties(sheetId,title,gridProperties(columnCount))",
      })
      const tab = process.env.GOOGLE_SHEET_TAB?.trim()
      const all = meta.data.sheets || []
      const sheet = tab ? all.find(x => x.properties?.title === tab) : all[0]
      if (!sheet?.properties) {
        throw new Error(
          tab
            ? `Tab "${tab}" not found. Tabs in this spreadsheet: ${all.map(x => x.properties?.title).join(", ")}. Fix GOOGLE_SHEET_TAB.`
            : "The spreadsheet has no tabs"
        )
      }
      const have = sheet.properties.gridProperties?.columnCount ?? 26
      if (have < HEADERS.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId(),
          requestBody: {
            requests: [
              { appendDimension: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", length: HEADERS.length - have } },
            ],
          },
        })
        console.log(`Sheet "${sheet.properties.title}": added ${HEADERS.length - have} column(s) so it has A-L`)
      }
    })().catch(e => {
      columnsReady = null // try again on the next request
      throw e
    })
  }
  return columnsReady
}

/** Turn a Google API error into a message an employee/admin can act on. */
export function sheetErrorMessage(err: unknown): string {
  const d = googleErrorDetails(err) as { error?: { message?: string } | string; error_description?: string } | string | undefined
  let msg =
    typeof d === "string"
      ? d
      : typeof d?.error === "object"
        ? d.error?.message || ""
        : [d?.error, d?.error_description].filter(Boolean).join(": ")
  if (!msg) msg = err instanceof Error ? err.message : String(err)
  const m = msg.toLowerCase()
  let hint = ""
  if (m.includes("missing in .env")) hint = ""
  else if (m.includes("requested entity was not found")) hint = "GOOGLE_SHEET_ID is wrong (copy it from the sheet URL between /d/ and /edit)."
  else if (m.includes("permission")) hint = `Share the sheet (Editor) with ${process.env.GOOGLE_CLIENT_EMAIL}.`
  else if (m.includes("unable to parse range")) hint = "GOOGLE_SHEET_TAB doesn't match a tab name - fix it or remove it."
  else if (m.includes("invalid_grant") || m.includes("decoder") || m.includes("private key") || m.includes("no key") || m.includes("pem"))
    hint = 'GOOGLE_PRIVATE_KEY or GOOGLE_CLIENT_EMAIL is wrong. Paste the key in double quotes on one line with \\n, exactly as in the JSON key file.'
  else if (m.includes("api has not been used") || m.includes("disabled")) hint = "Enable the Google Sheets API for the service account's Google Cloud project."
  return `Google Sheet error: ${msg}${hint ? ` -> ${hint}` : ""}`
}

export const normalize = (value: string) =>
  String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ")

/** Same "Egypt time" timestamp format the app has always written to CREATED_AT. */
export function nowStamp() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })
  ).toISOString()
}

export type SheetRow = {
  rowNumber: number // 1-based sheet row
  cells: string[]
}

/** Read every data row (A2:L). */
export async function readRows(): Promise<SheetRow[]> {
  await ensureColumns()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: r(`A2:${LAST_COL}`),
  })
  return (res.data.values || []).map((cells, i) => ({
    rowNumber: i + 2,
    cells: cells.map(c => String(c ?? "")),
  }))
}

/** Normalized set of every title already on the sheet (column D). */
export async function readExistingTitles(): Promise<Set<string>> {
  checkEnv()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: r("D2:D"),
  })
  return new Set((res.data.values || []).map(row => normalize(String(row[0] || ""))))
}

/** Write the G1:L1 headers once if they are missing. Cheap, safe to call often. */
export async function ensureGameBoostHeaders() {
  await ensureColumns()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: r("G1:L1"),
  })
  const current = res.data.values?.[0] || []
  if (current.filter(Boolean).length >= 6) return
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: r("G1:L1"),
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS.slice(6)] },
  })
}

/**
 * Append rows at an explicit "A{n}:L{m}" range.
 *
 * We deliberately avoid values.append: it asks Sheets to guess where the table
 * starts, and stray cells made it write into column F instead of A before.
 * `nextRow` comes from the caller's own read of the sheet.
 */
export async function writeRowsAt(nextRow: number, rows: (string | number)[][]) {
  if (!rows.length) return
  await ensureColumns()
  const lastRow = nextRow + rows.length - 1
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: r(`A${nextRow}:${LAST_COL}${lastRow}`),
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  })
}

/** Next empty row after everything currently in A:L. */
export async function nextEmptyRow(): Promise<number> {
  const rows = await readRows()
  return rows.length + 2
}

export type CellUpdate = { rowNumber: number; col: number; value: string | number }

/** Update individual cells in one round-trip. */
export async function updateCells(updates: CellUpdate[]) {
  if (!updates.length) return
  await ensureColumns()
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates.map(u => ({
        range: r(`${COL_LETTERS[u.col]}${u.rowNumber}`),
        values: [[u.value]],
      })),
    },
  })
}

/** Find the sheet row of a GameBoost offer, by offer id first, then external id. */
export function findRow(rows: SheetRow[], gbId: number | string, externalId?: string | null) {
  const id = String(gbId)
  return (
    rows.find(row => row.cells[COL.GB_OFFER_ID] === id) ||
    (externalId ? rows.find(row => row.cells[COL.EXTERNAL_ID] === externalId) : undefined)
  )
}

/** Pull the most useful detail out of a googleapis error for server logs. */
export function googleErrorDetails(err: unknown) {
  return err && typeof err === "object" && "response" in err
    ? (err as { response?: { data?: unknown } }).response?.data
    : err instanceof Error
      ? err.message
      : err
}

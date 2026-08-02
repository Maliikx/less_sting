import { google } from "googleapis"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
})

const sheets = google.sheets({
  version: "v4",
  auth,
})

/* ---------- GET HANDLER ---------- */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const employee = searchParams.get("employee")

  if (!employee) {
    return NextResponse.json({ count: 0 })
  }

  try {
    /* ---------- 1. CALCULATE TODAY (EGYPT TIME) ---------- */

    const egyptNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })
    )

    const startOfDay = new Date(egyptNow)
    startOfDay.setHours(0, 0, 0, 0)

    const endOfDay = new Date(startOfDay)
    endOfDay.setDate(endOfDay.getDate() + 1)

    /* ---------- 2. READ SHEET DATA (the actual source of truth) ---------- */
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "A2:F", // LINK | PRICE | EMPLOYEE | TITLE | NOTE | CREATED_AT
    })

    const rows = res.data.values || []

    /* ---------- 3. COUNT TODAY'S ROWS FOR THIS EMPLOYEE ---------- */
    let count = 0

    for (const row of rows) {
      const rowEmployee = row[2] // EMPLOYEE column
      const createdAt = row[5] // CREATED_AT column

      if (!rowEmployee || !createdAt) continue

      const createdDate = new Date(createdAt)
      if (isNaN(createdDate.getTime())) continue

      if (
        rowEmployee === employee &&
        createdDate >= startOfDay &&
        createdDate < endOfDay
      ) {
        count++
      }
    }

    /* ---------- 4. RETURN RESULT ---------- */
    return NextResponse.json({ count })
  } catch (err: unknown) {
    // Previously an unhandled error here would make the fetch's res.json() call
    // fail on the client, which was silently caught and reset the badge to 0 -
    // making an accurate count look "wrong" any time the Sheets read hiccuped.
    const details =
      err && typeof err === "object" && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : err instanceof Error
          ? err.message
          : err
    console.error("GET /api/offers/count error:", details)
    return NextResponse.json(
      { count: 0, error: "Could not read sheet" },
      { status: 500 }
    )
  }
}

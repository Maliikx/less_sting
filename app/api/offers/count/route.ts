import { NextResponse } from "next/server"
import { COL, googleErrorDetails, readRows, sheetErrorMessage } from "@/lib/sheets"

export const runtime = "nodejs"

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
    const rows = (await readRows()).map(r => r.cells) // LINK | PRICE | EMPLOYEE | TITLE | NOTE | CREATED_AT | ...

    /* ---------- 3. COUNT TODAY'S ROWS FOR THIS EMPLOYEE ---------- */
    let count = 0

    for (const row of rows) {
      const rowEmployee = row[COL.EMPLOYEE]
      const createdAt = row[COL.CREATED_AT]

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
    const details = googleErrorDetails(err)
    console.error("GET /api/offers/count error:", details)
    return NextResponse.json(
      { count: 0, error: sheetErrorMessage(err) },
      { status: 500 }
    )
  }
}

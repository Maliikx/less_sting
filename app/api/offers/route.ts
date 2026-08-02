import { google } from "googleapis"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

type Offer = {
  title: string
  link: string
  price: string
  note?: string
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
})

const sheets = google.sheets({ version: "v4", auth })

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ")

export async function POST(req: Request) {
  try {
    const body: { employee: string; offers: Offer[] } = await req.json()
    const { employee, offers } = body

    if (!employee || !offers?.length) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "D2:D",
    })

    const existingTitles = new Set(
      (existing.data.values || []).map(row => normalize(String(row[0] || "")))
    )

    const seenInBatch = new Set<string>()
    const validOffers: Offer[] = []
    const duplicateTitles: string[] = []

    for (const offer of offers) {
      const normalizedTitle = normalize(offer.title)
      // Check if title exists in sheet OR is repeated in the current form
      if (existingTitles.has(normalizedTitle) || seenInBatch.has(normalizedTitle)) {
        duplicateTitles.push(normalizedTitle)
      } else {
        seenInBatch.add(normalizedTitle)
        validOffers.push(offer)
      }
    }

    if (validOffers.length > 0) {
      const now = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })
      ).toISOString()

      const rows = validOffers.map(offer => [
        offer.link.trim(),
        offer.price.trim(),
        employee,
        offer.title.trim(),
        offer.note?.trim() || "",
        now,
      ])

      // IMPORTANT: we deliberately use values.update with an explicit row/column
      // range instead of values.append. append("A:F") asks Sheets to *guess*
      // where the existing table starts, and if any stray cell/formatting is
      // left anywhere in that open range it can decide the table begins at a
      // different column (this is what was writing new rows into column F
      // instead of A). Computing the exact next row ourselves and writing to
      // a pinned "A{row}:F{row}" range removes that ambiguity entirely.
      const nextRow = (existing.data.values?.length || 0) + 2 // header is row 1, data starts row 2
      const lastRow = nextRow + rows.length - 1

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `A${nextRow}:F${lastRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: rows },
      })
    }

    return NextResponse.json({
      success: true,
      addedCount: validOffers.length,
      skippedCount: duplicateTitles.length,
      duplicates: duplicateTitles, // Returning normalized titles
    })

  } catch (err: unknown) {
    // Log the real Google API error server-side (bad range, revoked share, wrong
    // sheet id, etc. all show up here instead of a generic 500 with no detail).
    const details =
      err && typeof err === "object" && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : err instanceof Error
          ? err.message
          : err
    console.error("POST /api/offers error:", details)
    return NextResponse.json(
      { error: "Server error - check server logs for details" },
      { status: 500 }
    )
  }
}

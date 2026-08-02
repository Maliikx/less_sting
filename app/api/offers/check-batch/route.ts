import { google } from "googleapis"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

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
    const body: { titles: string[] } = await req.json()
    const titles = (body?.titles || []).filter(Boolean)

    if (!titles.length) {
      return NextResponse.json({ duplicates: [] })
    }

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "D2:D",
    })

    const existingTitles = new Set(
      (existing.data.values || []).map(row => normalize(String(row[0] || "")))
    )

    const seen = new Set<string>()
    const duplicates: string[] = []

    for (const rawTitle of titles) {
      const normalized = normalize(rawTitle)
      if (!normalized) continue
      // Flag it if it's already on the sheet OR repeated earlier in the same form
      if (existingTitles.has(normalized) || seen.has(normalized)) {
        duplicates.push(normalized)
      } else {
        seen.add(normalized)
      }
    }

    return NextResponse.json({ duplicates })
  } catch (err) {
    console.error("check-batch error:", err)
    return NextResponse.json({ error: "Server error", duplicates: [] }, { status: 500 })
  }
}

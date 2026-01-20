import { google } from "googleapis"
import { NextResponse } from "next/server"

type Offer = {
  title: string
  link: string
  price: string
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
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

    /* ---------- 1. READ EXISTING TITLES ---------- */
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "D2:D", // TITLE column
    })

    const existingTitles = new Set(
      (existing.data.values || []).map(row =>
        normalize(String(row[0] || ""))
      )
    )

    /* ---------- 2. CHECK DUPLICATES ---------- */
    const duplicates = offers.filter(offer =>
      existingTitles.has(normalize(offer.title))
    )

    if (duplicates.length > 0) {
      return NextResponse.json(
        {
          error: "Duplicate titles detected",
          duplicates: duplicates.map(o => o.title),
        },
        { status: 409 }
      )
    }

    /* ---------- 3. INSERT ---------- */
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })
    ).toISOString()

    const rows = offers.map(offer => [
      offer.link.trim(),
      offer.price.trim(),
      employee,
      offer.title.trim(),
      now,
    ])

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("POST /api/offers error:", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

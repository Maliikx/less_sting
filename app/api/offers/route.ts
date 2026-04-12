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

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "A:F",
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

  } catch (err) {
    console.error("POST error:", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
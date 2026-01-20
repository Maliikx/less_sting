import { google } from "googleapis"
import { NextResponse } from "next/server"

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
})

const sheets = google.sheets({ version: "v4", auth })

export async function GET(req: Request) {
  const rawTitle = new URL(req.url).searchParams.get("title") || ""
  const title = rawTitle.trim().toLowerCase()

  if (!title) {
    return NextResponse.json({ exists: false })
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "D2:D", // TITLE column
  })

  const titles =
    res.data.values?.flat().map(t => t.trim().toLowerCase()) || []

  return NextResponse.json({
    exists: titles.includes(title),
  })
}

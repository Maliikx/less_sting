import { NextResponse } from "next/server"
import { normalize, readExistingTitles, sheetErrorMessage } from "@/lib/sheets"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const title = normalize(new URL(req.url).searchParams.get("title") || "")
  if (!title) return NextResponse.json({ exists: false })

  try {
    const titles = await readExistingTitles()
    return NextResponse.json({ exists: titles.has(title) })
  } catch (err) {
    console.error("GET /api/offers/check error:", err)
    return NextResponse.json({ exists: false, error: sheetErrorMessage(err) }, { status: 500 })
  }
}

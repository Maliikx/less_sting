import { NextResponse } from "next/server"
import { normalize, readExistingTitles, sheetErrorMessage } from "@/lib/sheets"

export const runtime = "nodejs"

export async function POST(req: Request) {
  try {
    const body: { titles: string[] } = await req.json()
    const titles = (body?.titles || []).filter(Boolean)

    if (!titles.length) {
      return NextResponse.json({ duplicates: [] })
    }

    const existingTitles = await readExistingTitles()

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
    return NextResponse.json({ error: sheetErrorMessage(err), duplicates: [] }, { status: 500 })
  }
}

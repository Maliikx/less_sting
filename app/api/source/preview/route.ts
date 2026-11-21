import { NextResponse } from "next/server"
import { checkSource } from "@/lib/sourcePage"

export const runtime = "nodejs"

/** GET /api/source/preview?url=<offer link>  ->  { status: ok|not_found|error, images[], message } */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const url = sp.get("url") || ""
  if (!url) return NextResponse.json({ status: "error", images: [], message: "url is required" }, { status: 400 })
  // &debug=1 shows the parts of the page around prices (for troubleshooting a site's layout)
  return NextResponse.json(await checkSource(url, { debug: sp.get("debug") === "1" }))
}

import { NextResponse } from "next/server"
import { errorMessage, GameBoostError } from "@/lib/gameboost"

/** Turn any thrown error into a JSON response with a sensible status code. */
export function errorResponse(e: unknown, context: string) {
  let status = e instanceof GameBoostError && e.status >= 400 ? e.status : 500
  // A GameBoost 401 means a bad API key, not that the app user is logged out
  if (status === 401) status = 502
  console.error(`${context}:`, errorMessage(e))
  return NextResponse.json({ error: errorMessage(e) }, { status })
}

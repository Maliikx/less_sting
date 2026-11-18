import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Next.js 16 renamed "middleware" to "proxy" (same behaviour).
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session"

// Routes reachable without a session.
//  - /api/login: obviously
//  - /api/gameboost/sync: checks its own `Authorization: Bearer $CRON_SECRET` (or a session)
const PUBLIC_API = ["/api/login", "/api/gameboost/sync"]

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isLoggedIn = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
  const isLoginPage = pathname.startsWith("/login")
  const isApi = pathname.startsWith("/api")

  if (isApi) {
    // Previously ALL /api routes were open to anyone. Now they need a session.
    if (!isLoggedIn && !PUBLIC_API.some(p => pathname.startsWith(p))) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 })
    }
    return NextResponse.next()
  }

  if (!isLoggedIn && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  if (isLoggedIn && isLoginPage) {
    return NextResponse.redirect(new URL("/", req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}

import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(req: NextRequest) {
  const isLoggedIn = req.cookies.get("auth")?.value === "true"
  const isLoginPage = req.nextUrl.pathname.startsWith("/login")
  const isApi = req.nextUrl.pathname.startsWith("/api")

  if (!isLoggedIn && !isLoginPage && !isApi) {
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

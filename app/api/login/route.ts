import { NextResponse } from "next/server"
import { createSessionToken, passwordMatches, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: undefined }))

  // Most common setup mistake: the env file wasn't copied to the new folder / host
  if (!process.env.APP_PASSWORD?.trim()) {
    console.error("Login: APP_PASSWORD is not set (check .env.local or your host's environment variables)")
    return NextResponse.json(
      { error: "Server setup problem: APP_PASSWORD is not set. Add it to .env.local (or your host's env vars) and restart." },
      { status: 500 }
    )
  }

  if (!passwordMatches(password)) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 })
  }

  const res = NextResponse.json({ success: true })

  // Only mark the cookie Secure when the site is actually served over HTTPS,
  // otherwise browsers drop it on http://<LAN-IP> and login silently loops.
  const proto = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "")
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: proto === "https",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  })
  // Remove the old forgeable cookie if a browser still has it
  res.cookies.set("auth", "", { path: "/", maxAge: 0 })

  return res
}

/** Log out */
export async function DELETE() {
  const res = NextResponse.json({ success: true })
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 })
  return res
}

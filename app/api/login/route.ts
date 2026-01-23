import { NextResponse } from "next/server"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const { password } = await req.json()

  if (password !== process.env.APP_PASSWORD) {
    return new NextResponse("Unauthorized", { status: 401 })
  }

  const res = NextResponse.json({ success: true })

  res.cookies.set("auth", "true", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24, // 1 day
  })

  return res
}

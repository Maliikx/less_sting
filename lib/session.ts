/**
 * Signed session cookie (works in middleware/edge and in Node route handlers).
 *
 * Before: the cookie was literally `auth=true`, so anyone could set it by hand,
 * and every /api route was open to the internet. With GameBoost create/edit/delete
 * behind those routes that is no longer acceptable.
 *
 * Token = "<expiresAtMs>.<base64url HMAC-SHA256(secret, 'v1.' + expiresAtMs)>"
 */

export const SESSION_COOKIE = "ls_session"
export const SESSION_MAX_AGE = 60 * 60 * 24 // 1 day, same as before

function secret() {
  const s = process.env.SESSION_SECRET || process.env.APP_PASSWORD
  if (!s) throw new Error("Set SESSION_SECRET (or at least APP_PASSWORD)")
  return s
}

function b64url(buf: ArrayBuffer) {
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sign(data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function createSessionToken() {
  const exp = Date.now() + SESSION_MAX_AGE * 1000
  return `${exp}.${await sign(`v1.${exp}`)}`
}

export async function verifySessionToken(token: string | undefined | null) {
  if (!token) return false
  const [expStr, sig] = token.split(".")
  const exp = Number(expStr)
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false
  try {
    return safeEqual(sig, await sign(`v1.${exp}`))
  } catch {
    return false
  }
}

/** For route handlers: read the cookie off a Request. */
export async function isAuthed(req: Request) {
  const cookie = req.headers.get("cookie") || ""
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  return verifySessionToken(m ? decodeURIComponent(m[1]) : null)
}

export function passwordMatches(input: unknown) {
  // Trim both sides: stray spaces/newlines from copy-paste or the env file shouldn't lock people out
  const expected = process.env.APP_PASSWORD?.trim()
  return typeof input === "string" && !!expected && safeEqual(input.trim(), expected)
}

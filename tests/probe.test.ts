import test from "node:test"
import assert from "node:assert/strict"
import { dedupeLinks, parseProbeRequest, probeLinks, summarize, PROBE_GAP_MS, PROBE_MAX_LINKS } from "../lib/sources/probe"
import { readSourceOffer } from "../lib/sources/index"
import type { FetchedPage } from "../lib/sources/types"
import { BLOCKED_PAGE, DEAD_OFFER, EN_OFFER } from "./fixtures"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`

/** Fake site: lot id -> [status, html]. Records every URL asked for. */
function fakeSite(pages: Record<string, [number, string] | Error>) {
  const asked: string[] = []
  const fetcher = async (url: string): Promise<FetchedPage> => {
    asked.push(url)
    const id = new URL(url).searchParams.get("id") || ""
    const p = pages[id]
    if (!p) throw new Error("no such page in fake site")
    if (p instanceof Error) throw p
    return { status: p[0], html: p[1], finalUrl: new URL(url) }
  }
  return { fetcher, asked }
}

function fakeSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

test("probe: dedupe by lot id across language paths, keeps first, reports repeats", () => {
  const { links, repeated } = dedupeLinks([L("101"), "  ", "https://funpay.com/lots/offer?id=101", L("102"), "junk", "junk", L("102") + "&x=1"])
  assert.deepEqual(links, [L("101"), L("102"), "junk"])
  assert.equal(repeated.length, 3)
})

test("probe: one row per link with status, http code, title, images, price, params, warnings", async () => {
  const site = fakeSite({ "101": [200, EN_OFFER], "102": [404, DEAD_OFFER], "103": [403, BLOCKED_PAGE], "104": new Error("fetch failed") })
  const { sleep } = fakeSleep()
  const rows = await probeLinks([L("101"), L("102"), L("103"), L("104")], { fetcher: site.fetcher, sleep })
  assert.deepEqual(rows.map(r => r.status), ["ok", "not_found", "blocked", "error"])
  assert.deepEqual(rows.map(r => r.lotId), ["funpay:101", "funpay:102", "funpay:103", "funpay:104"])
  assert.equal(rows[1].httpStatus, 404)
  assert.equal(rows[2].httpStatus, 403)
  assert.equal(rows[3].message, "fetch failed")
  const ok = rows[0]
  assert.ok(ok.title.length > 0)
  assert.ok(ok.descriptionChars > 0)
  assert.ok(ok.priceText)
  assert.ok(Array.isArray(ok.params) && Array.isArray(ok.warnings))
  assert.equal(ok.html, undefined, "HTML only when asked for")
})

test("probe: waits the gap before every request after the first, never for unsupported links", async () => {
  const site = fakeSite({ "101": [200, EN_OFFER], "102": [200, EN_OFFER], "103": [200, EN_OFFER] })
  const s = fakeSleep()
  await probeLinks(["not a link", L("101"), "https://example.com/x", L("102"), L("103")], { fetcher: site.fetcher, sleep: s.sleep })
  assert.deepEqual(s.waits, [PROBE_GAP_MS, PROBE_GAP_MS], "3 fetches -> 2 waits")
  assert.equal(site.asked.length, 3, "unsupported links never hit the network")
  assert.ok(PROBE_GAP_MS >= 1500, "do not lower the gap below 1.5 s")
})

test("probe: includeHtml returns the raw page (also for dead/blocked pages)", async () => {
  const site = fakeSite({ "101": [200, EN_OFFER], "102": [404, DEAD_OFFER] })
  const rows = await probeLinks([L("101"), L("102")], { fetcher: site.fetcher, sleep: fakeSleep().sleep, includeHtml: true })
  assert.equal(rows[0].html, EN_OFFER)
  assert.equal(rows[1].html, DEAD_OFFER)
})

test("probe: summary counts statuses and hit rates over ok pages only", async () => {
  const site = fakeSite({ "101": [200, EN_OFFER], "102": [404, DEAD_OFFER], "103": [429, BLOCKED_PAGE] })
  const rows = await probeLinks([L("101"), L("102"), L("103")], { fetcher: site.fetcher, sleep: fakeSleep().sleep })
  const s = summarize(rows)
  assert.deepEqual(s.byStatus, { ok: 1, not_found: 1, blocked: 1, error: 0 })
  assert.equal(s.hitRates.title, 100)
  assert.equal(s.hitRates.price, 100)
  assert.ok(Math.abs(s.blockedShare - 1 / 3) < 1e-9)
  assert.deepEqual(summarize([]).hitRates, { title: 0, description: 0, images: 0, price: 0, params: 0 })
})

test("probe: request validation caps chunk size and rejects bad input", () => {
  assert.ok("error" in parseProbeRequest(null))
  assert.ok("error" in parseProbeRequest({ links: "x" }))
  assert.ok("error" in parseProbeRequest({ links: [] }))
  assert.ok("error" in parseProbeRequest({ links: Array(PROBE_MAX_LINKS + 1).fill(L("101")) }))
  assert.deepEqual(parseProbeRequest({ links: [` ${L("101")} `], includeHtml: true }), { links: [L("101")], includeHtml: true })
  assert.deepEqual(parseProbeRequest({ links: [L("101")], includeHtml: "yes" }), { links: [L("101")], includeHtml: false })
})

test("readSourceOffer keeps its old behaviour with an injected fetcher", async () => {
  const site = fakeSite({ "101": [200, EN_OFFER] })
  const o = await readSourceOffer("https://funpay.com/ru/lots/offer?id=101", site.fetcher)
  assert.equal(o.status, "ok")
  assert.equal(o.canonicalId, "funpay:101")
  assert.match(site.asked[0], /\/en\/lots\/offer\?id=101$/, "always reads the English page")
  assert.equal((await readSourceOffer("not a link")).status, "error")
})

test("POST /api/source/probe needs a session (route check, not only proxy.ts)", async () => {
  process.env.SESSION_SECRET ||= "test-secret"
  const { POST } = await import("../app/api/source/probe/route")
  const res = await POST(new Request("http://localhost/api/source/probe", { method: "POST", body: JSON.stringify({ links: [L("101")] }) }))
  assert.equal(res.status, 401)
  const { createSessionToken, SESSION_COOKIE } = await import("../lib/session")
  const bad = await POST(
    new Request("http://localhost/api/source/probe", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${await createSessionToken()}` },
      body: JSON.stringify({ links: [] }),
    })
  )
  assert.equal(bad.status, 400, "logged in, but empty input is rejected before any fetch")
})

test("proxy.ts blocks /probe and /api/source/probe without a session", async () => {
  process.env.SESSION_SECRET ||= "test-secret"
  const { NextRequest } = await import("next/server")
  const { proxy } = await import("../proxy")
  const api = await proxy(new NextRequest("http://localhost/api/source/probe", { method: "POST" }))
  assert.equal(api.status, 401)
  const page = await proxy(new NextRequest("http://localhost/probe"))
  assert.equal(page.status, 307)
  assert.match(page.headers.get("location") || "", /\/login$/)
})

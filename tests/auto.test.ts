import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseBatch, parseLine } from "../lib/auto/lines"
import { prepareBatch } from "../lib/auto/batch"
import { matchGame, resolveGame, gameKey, type GameRef } from "../lib/auto/games"
import { revalidate, toPublishItem, canPublish, type ReviewRow } from "../lib/auto/review"
import { buildOffersRequests, gameboostDestination, mapAnswer, sheetNote } from "../lib/destinations/gameboost"
import { parsePublishRequest } from "../lib/auto/publishRequest"
import { MemoryStateStore } from "../lib/state/store"
import { funpay } from "../lib/sources/funpay"
import type { SourceOffer } from "../lib/sources/types"
import type { PublishItem } from "../lib/destinations/types"
import { formSchema } from "../app/schema"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`
const real = (id: string) => readFileSync(join(__dirname, "fixtures", "real", `${id}.html`), "utf8")
const parseReal = (id: string): SourceOffer => funpay.parse({ status: 200, html: real(id), finalUrl: new URL(L(id)) })
const PUBG: GameRef = { id: 7, slug: "pubg-mobile", name: "PUBG Mobile" }

/* ------------------------------------------------------------ paste box */

test("lines: link price seller in any order; spaces, tabs or commas; multipliers; comma decimals", () => {
  assert.deepEqual(
    [parseLine(`${L("81847225")} x1.5 S01`, 1), parseLine(`S02\t${L("81843891")}\t45`, 2), parseLine(`${L("81844586")},1.75x,S03`, 3), parseLine(`${L("81845244")} 12,5 Ahmed M`, 4)].map(
      l => [l.lotId, l.price, l.seller, l.error]
    ),
    [
      ["funpay:81847225", "x1.5", "S01", undefined],
      ["funpay:81843891", "45", "S02", undefined],
      ["funpay:81844586", "1.75x", "S03", undefined],
      ["funpay:81845244", "12.5", "Ahmed M", undefined],
    ]
  )
  assert.equal(parseLine(`${L("1234567")} S01`, 1).error, "no price (number or multiplier like x2)")
  assert.equal(parseLine(`${L("1234567")} 20`, 1).error, "no seller code")
  assert.equal(parseLine(`https://funpay.com/en/lots/346/ 20 S1`, 1).error, "not a FunPay single-offer link")
  assert.equal(parseLine(`20 S1`, 1).error, "no link")
})

test("lines: first line per lot id wins (across /en, /ru, extra params); invalid lines reported", () => {
  const r = parseBatch([`${L("111222")} 10 A`, "", `https://funpay.com/ru/lots/offer?id=111222&x=1 20 B`, `${L("333444")} 5 C`, "junk"].join("\n"))
  assert.deepEqual(r.lines.map(l => l.lotId), ["funpay:111222", "funpay:333444"])
  assert.deepEqual(r.repeated.map(l => l.line), [3])
  assert.deepEqual(r.invalid.map(l => l.line), [5])
})

/* ------------------------------------------------------------ prepare batch */

function readerFor(pages: Record<string, SourceOffer>, log: string[]) {
  return async (link: string) => {
    const id = new URL(link).searchParams.get("id")!
    log.push(id)
    return pages[id]
  }
}

test("batch: one page at a time, 1.5 s apart; duplicates and repeats are never read and cost no wait", async () => {
  const log: string[] = []
  const waits: number[] = []
  const pages = { "81847225": parseReal("81847225"), "81846982": parseReal("81846982") }
  const out = await prepareBatch(
    [
      { link: L("81847225"), price: "x2", seller: "S1" },
      { link: L("999000"), price: "10", seller: "S1" }, // in the sheet
      { link: L("81847225"), price: "x3", seller: "S2" }, // repeated in batch
      { link: L("81846982"), price: "40", seller: "S1" },
    ],
    { readOffer: readerFor(pages, log), ai: null, game: null, listed: id => (id === "funpay:999000" ? "sheet row 12" : null), sleep: async ms => void waits.push(ms) }
  )
  assert.deepEqual(log, ["81847225", "81846982"])
  assert.deepEqual(waits, [1500])
  assert.deepEqual([out[1].status, out[2].status], ["duplicate", "duplicate"])
  assert.match(out[1].flags[0].message, /sheet row 12/)
  assert.match(out[2].flags[0].message, /repeated in this batch/)
})

test("batch: game from the category; unknown game -> flagged game_unknown, needs review", async () => {
  const pages = { "81847225": parseReal("81847225"), "81843891": parseReal("81843891") }
  const out = await prepareBatch(
    [
      { link: L("81847225"), price: "x2", seller: "S1" },
      { link: L("81843891"), price: "40", seller: "S1" },
    ],
    {
      readOffer: readerFor(pages, []),
      ai: null,
      game: null,
      gameFor: async src => (src.categoryId === "346" ? { gameId: PUBG.id, gameSlug: PUBG.slug, gameName: PUBG.name, specs: [{ key: "level", type: "integer", required: true }] } : null),
      listed: () => null,
      sleep: async () => {},
    }
  )
  assert.deepEqual(out[0].game, PUBG)
  assert.equal(out[0].accountData.level, 82, "filled from the FunPay params")
  assert.equal(out[0].status, "ready")
  assert.equal(out[0].priceEur, 361.28, "x2 of the USD buyer price 180.64")
  assert.equal(out[1].game, null)
  assert.equal(out[1].category, "Raid: Shadow Legends Accounts")
  assert.ok(out[1].flags.some(f => f.code === "game_unknown" && f.level === "error"))
  assert.equal(out[1].status, "needs_review")
})

/* ------------------------------------------------------------ games */

test("games: exact unique name only; picks and matches are remembered; no fuzzy guesses", async () => {
  const list: GameRef[] = [PUBG, { id: 8, slug: "pubg", name: "PUBG: Battlegrounds" }]
  assert.deepEqual(matchGame("PUBG Mobile", list), PUBG)
  assert.equal(matchGame("PUBG", list), null)
  assert.equal(matchGame("Tom Clancy's Rainbow Six", [{ id: 1, slug: "r6", name: "Rainbow Six Siege" }]), null)
  assert.equal(matchGame("x", [{ id: 1, slug: "a", name: "X" }, { id: 2, slug: "b", name: "x" }]), null, "ambiguous")

  const store = new MemoryStateStore()
  let searches = 0
  const searchGames = async () => { searches++; return list }
  const src = { source: "funpay", categoryId: "346", game: "PUBG Mobile" }
  assert.deepEqual(await resolveGame(src, { store, searchGames }), PUBG)
  assert.deepEqual(await resolveGame(src, { store, searchGames }), PUBG)
  assert.equal(searches, 1, "the auto match is remembered")

  const raid = { source: "funpay", categoryId: "566", game: "Raid: Shadow Legends" }
  assert.equal(await resolveGame(raid, { store, searchGames }), null)
  const RAID = { id: 9, slug: "raid", name: "RAID: Shadow Legends" }
  assert.deepEqual(await resolveGame(raid, { store, searchGames, picks: { "566": RAID } }), RAID)
  assert.deepEqual(await resolveGame(raid, { store, searchGames: async () => [] }), RAID, "the user's pick is remembered")
  assert.equal(((await store.get(gameKey("funpay", "566")))!.value as { by: string }).by, "user")
})

/* ------------------------------------------------------------ review edits */

async function preparedRow(id: string, patch: Partial<SourceOffer> = {}): Promise<ReviewRow> {
  const [row] = await prepareBatch([{ link: L(id), price: "20", seller: "S1" }], {
    readOffer: async () => ({ ...parseReal(id), ...patch }),
    ai: null,
    game: { gameId: PUBG.id, gameSlug: PUBG.slug, gameName: PUBG.name, specs: [] },
    listed: () => null,
  })
  return { ...row, game: PUBG }
}

test("review: adding image links by hand turns a no-images offer ready; imgur and banned words are not accepted", async () => {
  const row = await preparedRow("81849764") // real offer without images
  assert.equal(row.status, "needs_review")
  assert.ok(row.flags.some(f => f.code === "no_images"))
  assert.equal(canPublish(row), false)

  const imgur = revalidate({ ...row, images: ["https://i.imgur.com/abcdE12.jpg"] })
  assert.equal(imgur.status, "needs_review")
  const fixed = revalidate({ ...row, images: ["https://i.postimg.cc/AbC/shot.png"] })
  assert.equal(fixed.status, "ready")
  assert.equal(canPublish(fixed), true)

  const banned = revalidate({ ...fixed, description: fixed.description + " Instant delivery and full guarantee." })
  assert.equal(banned.status, "needs_review")
  assert.ok(banned.flags.some(f => f.code === "violation"))

  const badPrice = revalidate({ ...fixed, priceInput: "abc" })
  assert.equal(badPrice.status, "needs_review")
  assert.equal(revalidate({ ...fixed, priceInput: "x2" }).priceEur, 572.9)
})

test("review: dead / duplicate / blocked rows stay as they are", async () => {
  const [dead] = await prepareBatch([{ link: L("71122224"), price: "20", seller: "S1" }], {
    readOffer: async () => funpay.parse({ status: 404, html: real("dead-71122224"), finalUrl: new URL(L("71122224")) }),
    ai: null, game: null, listed: () => null,
  })
  assert.equal(revalidate({ ...dead, images: ["https://x/y.jpg"] }).status, "dead")
})

/* ------------------------------------------------------------ destination (existing POST /api/offers) */

const ITEM = (o: Partial<PublishItem> = {}): PublishItem => ({
  ref: "funpay:81847225", link: L("81847225"), seller: "S1", title: "Blood Raven X-Suit | Glacier M416", description: "Full access account.",
  images: ["https://sfunpay.com/s/offer/9f/ry/9fryp1oxw2cs5n0dnvtd.jpg"], priceInput: "x2", sourcePrice: 180.64,
  accountData: { level: 82, platform: "Android" }, defaulted: ["platform"], notes: [], game: PUBG, ...o,
})
const SETTINGS = { listNow: false, deliveryDuration: 1, deliveryUnit: "hours" as const }

test("destination: one request per seller+game, valid for the EXISTING form schema, drafts, defaulted fields in the note", () => {
  const reqs = buildOffersRequests(
    [ITEM(), ITEM({ ref: "funpay:2", title: "Second offer title", seller: "S2" }), ITEM({ ref: "funpay:3", title: "Third offer title" }), ITEM({ ref: "funpay:4", title: "Raid acc", game: { id: 9, slug: "raid", name: "RAID" } })],
    SETTINGS
  )
  assert.equal(reqs.length, 3)
  for (const r of reqs) {
    const parsed = formSchema.safeParse(r.body)
    assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues))
    assert.equal(r.body.gameboost.listNow, false, "drafts")
  }
  const s1 = reqs.find(r => r.body.employee === "S1" && r.body.gameboost.gameId === 7)!
  assert.equal(s1.items.length, 2)
  assert.equal(s1.body.offers[0].price, "x2")
  assert.equal(s1.body.offers[0].sourcePrice, "180.64")
  assert.equal(s1.body.offers[0].note, "auto · defaulted: platform")
  assert.deepEqual(JSON.parse(s1.body.offers[0].accountData), { level: 82, platform: "Android" })
  assert.equal(sheetNote(ITEM({ defaulted: [], notes: ["album images"] })), "auto · album images")
})

test("destination: answers map back per row: created, duplicate, failed (with missing fields), sheet failure, network failure", async () => {
  const items = [ITEM(), ITEM({ ref: "funpay:2", title: "Second  offer" }), ITEM({ ref: "funpay:3", title: "Third offer" }), ITEM({ ref: "funpay:4", title: "Fourth" })]
  const res = mapAnswer(items, 200, {
    published: [{ title: "blood raven x-suit | glacier m416", id: 501, status: "draft" }],
    duplicates: ["second offer"],
    failed: [{ title: "third offer", error: "422 Unprocessable", missingFields: ["rank"] }],
  })
  assert.deepEqual(res.map(r => [r.ref, r.status, r.offerId]), [["funpay:81847225", "created", 501], ["funpay:2", "duplicate", undefined], ["funpay:3", "failed", undefined], ["funpay:4", "failed", undefined]])
  assert.match(res[2].error!, /missing: rank/)

  const sheet = mapAnswer([ITEM()], 500, { error: "sheet down", published: [{ title: "blood raven x-suit | glacier m416", id: 9, status: "draft" }] })
  assert.equal(sheet[0].status, "created")
  assert.match(sheet[0].warning!, /NOT written to the sheet/)

  const calls: unknown[] = []
  const dest = gameboostDestination(async body => { calls.push(body); throw new Error("timeout") })
  const out = await dest.publish([ITEM()], SETTINGS)
  assert.equal(calls.length, 1, "never retried blindly")
  assert.match(out[0].error!, /Check \/manage/)
})

/* ------------------------------------------------------------ publish request (server-side gate) */

test("publish request: server re-checks images and banned words; listNow comes from the server only", () => {
  const ok = parsePublishRequest({ items: [{ ...ITEM(), listNow: true }], settings: { deliveryDuration: 1, deliveryUnit: "hours" } }, false)
  assert.ok(!("error" in ok))
  assert.equal(ok.settings.listNow, false)
  const err = (items: unknown[], settings: unknown = { deliveryDuration: 1, deliveryUnit: "hours" }) => {
    const r = parsePublishRequest({ items, settings }, false)
    return "error" in r ? r.error : ""
  }
  assert.match(err([ITEM({ images: ["https://i.imgur.com/a.jpg"] })]), /imgur/)
  assert.match(err([ITEM({ images: [] })]), /image/)
  assert.match(err([ITEM({ description: "Instant delivery, warranty included" })]), /still contains|banned/)
  assert.match(err([{ ...ITEM(), game: undefined }]), /no game/)
  assert.match(err([ITEM(), ITEM()]), /repeated/)
  assert.match(err(Array.from({ length: 21 }, (_, i) => ITEM({ ref: `r${i}` }))), /At most 20/)
  assert.match(err([ITEM()], { deliveryDuration: 0, deliveryUnit: "hours" }), /whole number/)
  assert.match(err([]), /No offers/)
})

test("toPublishItem carries defaulted keys and the album note", async () => {
  const row = await preparedRow("81847225")
  const item = toPublishItem({ ...row, albumImages: true, defaulted: [{ key: "rank", value: "Bronze", reason: "not found" }] })
  assert.deepEqual(item.defaulted, ["rank"])
  assert.deepEqual(item.notes, ["album images"])
  assert.equal(item.ref, "funpay:81847225")
})

test("routes need a session: /api/auto/publish and /api/ai/prepare", async () => {
  process.env.SESSION_SECRET ||= "test-secret"
  const { POST: publish } = await import("../app/api/auto/publish/route")
  const { POST: prepare } = await import("../app/api/ai/prepare/route")
  const req = (u: string) => new Request(`http://localhost${u}`, { method: "POST", body: "{}" })
  assert.equal((await publish(req("/api/auto/publish"))).status, 401)
  assert.equal((await prepare(req("/api/ai/prepare"))).status, 401)
})

test("rental offers (FunPay 'Offer type: Rent' / 'Аренда') are flagged and cannot be published", async () => {
  const rent = { ...parseReal("81847225"), params: { "Offer type": "Rent", Level: "82" } }
  const [row] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "S1" }], {
    readOffer: async () => rent, ai: null, game: { gameId: PUBG.id, gameSlug: PUBG.slug, gameName: PUBG.name, specs: [] }, listed: () => null,
  })
  assert.ok(row.flags.some(f => f.code === "rental"))
  assert.equal(row.status, "needs_review")
  assert.equal(revalidate({ ...row, game: PUBG }).status, "needs_review", "an edit does not clear it")
  const [ru] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "S1" }], {
    readOffer: async () => ({ ...rent, params: { "Тип предложения": "Аренда" } }), ai: null, game: null, listed: () => null,
  })
  assert.ok(ru.flags.some(f => f.code === "rental"))
  const [sale] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "S1" }], {
    readOffer: async () => parseReal("81847225"), ai: null, game: null, listed: () => null,
  })
  assert.ok(!sale.flags.some(f => f.code === "rental"))
})

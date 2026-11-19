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

test("batch: duplicates are found by TITLE (original or cleaned) in the sheet and in this batch; the same link twice is not read", async () => {
  const { titleKey } = await import("../lib/text")
  const log: string[] = []
  const a = parseReal("81847225") // "Blood Raven X-Suit | Glacier M416 Lv6 | OG S6 S7 S8 RP | S5 Hair"
  const b = parseReal("81846982")
  const c = { ...parseReal("81847074"), title: a.title } // another lot, same title as `a`
  const d = parseReal("62421214") // emoji title: matched the way the sheet stores it (space after emojis)
  const pages = { "81847225": a, "81846982": b, "81847074": c, "62421214": d }
  const sheet = new Map([[titleKey(b.title!), "sheet row 12: C1S3 Conqueror"], [titleKey(d.title!), "sheet row 40: Apex"]])
  const out = await prepareBatch(
    [
      { link: L("81847225"), price: "x2", seller: "S1" },
      { link: L("81846982"), price: "10", seller: "S1" }, // title in the sheet
      { link: L("81847225"), price: "x3", seller: "S1" }, // same link again
      { link: L("81847074"), price: "40", seller: "S1" }, // same title as line 1
      { link: L("62421214"), price: "40", seller: "S1" },
    ],
    { readOffer: readerFor(pages, log), ai: null, game: null, listedTitle: k => sheet.get(k) ?? null, sleep: async () => {}, concurrency: 1 }
  )
  assert.deepEqual(log, ["81847225", "81846982", "81847074", "62421214"], "the repeated link is never read")
  assert.deepEqual(out.map(o => o.status === "duplicate"), [false, true, true, true, true])
  assert.match(out[1].flags[0].message, /same title\): sheet row 12/)
  assert.match(out[2].flags[0].message, /earlier in this batch/)
  assert.match(out[3].flags[0].message, /same title as line 1/)
  assert.match(out[4].flags[0].message, /sheet row 40/)
  assert.equal(out[1].aiUsed, false, "no AI spent on duplicates")
})

test("batch: page reads START at least 1.5 s apart even with 3 offers in flight; results keep input order", async () => {
  const { startGate } = await import("../lib/auto/batch")
  let t = 0
  const starts: number[] = []
  const gate = startGate(1500, async ms => { t += ms }, () => t)
  for (let i = 0; i < 4; i++) starts.push(await gate())
  assert.deepEqual(starts, [0, 1500, 3000, 4500])

  // concurrent, real time (small gap): a slow first offer does not hold up the next read, but reads stay spaced
  const readAt: number[] = []
  const ids = ["81847225", "81846982", "81847074", "81846752"]
  const t0 = Date.now()
  const out = await prepareBatch(
    ids.map(id => ({ link: L(id), price: "10", seller: "S1" })),
    {
      readOffer: async link => {
        readAt.push(Date.now())
        const id = new URL(link).searchParams.get("id")!
        if (id === "81847225") await new Promise(r => setTimeout(r, 200)) // slow (like an AI call)
        return parseReal(id)
      },
      ai: null, game: null, listedTitle: () => null, gapMs: 40, concurrency: 3,
    }
  )
  for (let i = 1; i < readAt.length; i++) assert.ok(readAt[i] - readAt[i - 1] >= 38, `reads ${i - 1}->${i} were ${readAt[i] - readAt[i - 1]} ms apart`)
  assert.ok(readAt[1] - t0 < 150, "the 2nd read did not wait for the slow 1st offer")
  assert.deepEqual(out.map(o => o.canonicalId), ids.map(id => `funpay:${id}`))
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
      listedTitle: () => null,
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
    listedTitle: () => null,
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
    ai: null, game: null, listedTitle: () => null,
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
  assert.match(out[0].error!, /Press Publish again/)
})

/* ------------------------------------------------------------ publish request (server-side gate) */

test("publish request: server re-checks images and banned words; draft unless the user chose List immediately", () => {
  const SET = { deliveryDuration: 1, deliveryUnit: "hours" }
  const ok = parsePublishRequest({ items: [ITEM()], settings: SET })
  assert.ok(!("error" in ok))
  assert.equal(ok.settings.listNow, false, "default = draft")
  const listed = parsePublishRequest({ items: [ITEM()], settings: { ...SET, listNow: true, deliveryInstructions: "  Add me on Discord after purchase  " } })
  assert.ok(!("error" in listed))
  assert.equal(listed.settings.listNow, true)
  assert.equal(listed.settings.deliveryInstructions, "Add me on Discord after purchase")
  const truthy = parsePublishRequest({ items: [ITEM()], settings: { ...SET, listNow: "yes" } })
  assert.ok(!("error" in truthy) && truthy.settings.listNow === false, "only literal true lists")
  const err = (items: unknown[], settings: unknown = SET) => {
    const r = parsePublishRequest({ items, settings })
    return "error" in r ? r.error : ""
  }
  assert.match(err([ITEM({ images: ["https://i.imgur.com/a.jpg"] })]), /imgur/)
  assert.match(err([ITEM({ images: [] })]), /image/)
  assert.match(err([ITEM({ description: "Instant delivery, warranty included" })]), /still contains|banned/)
  assert.match(err([{ ...ITEM(), game: undefined }]), /no game/)
  assert.match(err([ITEM(), ITEM()]), /repeated/)
  assert.match(err(Array.from({ length: 21 }, (_, i) => ITEM({ ref: `r${i}` }))), /At most 20/)
  assert.match(err([ITEM()], { deliveryDuration: 0, deliveryUnit: "hours" }), /whole number/)
  assert.match(err([ITEM()], { ...SET, deliveryInstructions: "x".repeat(2049) }), /2048/)
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
    readOffer: async () => rent, ai: null, game: { gameId: PUBG.id, gameSlug: PUBG.slug, gameName: PUBG.name, specs: [] }, listedTitle: () => null,
  })
  assert.ok(row.flags.some(f => f.code === "rental"))
  assert.equal(row.status, "needs_review")
  assert.equal(revalidate({ ...row, game: PUBG }).status, "needs_review", "an edit does not clear it")
  const [ru] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "S1" }], {
    readOffer: async () => ({ ...rent, params: { "Тип предложения": "Аренда" } }), ai: null, game: null, listedTitle: () => null,
  })
  assert.ok(ru.flags.some(f => f.code === "rental"))
  const [sale] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "S1" }], {
    readOffer: async () => parseReal("81847225"), ai: null, game: null, listedTitle: () => null,
  })
  assert.ok(!sale.flags.some(f => f.code === "rental"))
})

/* ------------------------------------------------------------ retry after a timeout (HTTP 504) */

test("publish retry after a timeout: offers already on GameBoost are NOT created again; their sheet row is added", async () => {
  const { sameTitle, sheetRowForExisting } = await import("../lib/destinations/gameboost")
  const a = ITEM({ ref: "funpay:1", title: "Alpha 🔥account" })
  const b = ITEM({ ref: "funpay:2", title: "Beta account" })
  const c = ITEM({ ref: "funpay:3", title: "Gamma account" })
  const created: string[] = []
  const logged: string[] = []
  const dest = gameboostDestination(
    async body => {
      const offers = (body as { offers: { title: string }[] }).offers
      created.push(...offers.map(o => o.title))
      return { status: 200, json: { published: offers.map((o, i) => ({ title: o.title.toLowerCase(), id: 700 + i, status: "draft" })) } }
    },
    {
      // "Alpha" was created by the run that timed out
      findExisting: async it => (sameTitle(it.title, "alpha 🔥 account") ? { id: 555, status: "draft", externalId: "ls-m-x" } : null),
      logExisting: async found => void logged.push(...found.map(f => f.item.ref)),
    }
  )
  const out = await dest.publish([a, b, c], SETTINGS)
  assert.deepEqual(created, ["Beta account", "Gamma account"], "Alpha is not created twice")
  assert.deepEqual(logged, ["funpay:1"])
  assert.deepEqual(out.map(r => [r.ref, r.status, r.offerId]), [["funpay:1", "created", 555], ["funpay:2", "created", 700], ["funpay:3", "created", 701]])
  assert.match(out[0].warning!, /already on GameBoost/)

  const row = sheetRowForExisting(a, { id: 555, status: "draft", externalId: "ls-m-x", price: "361.28" }, "18/11/2026")
  assert.equal(row.length, 12, "A-L, same layout as POST /api/offers")
  assert.deepEqual([row[0], row[1], row[2], row[6], row[7], row[8], row[10]], [a.link, "x2", "S1", 555, "draft", "ls-m-x", "PUBG Mobile"])
  assert.match(String(row[4]), /recovered after an interrupted publish/)
})

test("publish: if GameBoost can't be checked for an existing offer, that offer is not created (no duplicate risk)", async () => {
  const created: string[] = []
  const dest = gameboostDestination(
    async body => { created.push(...(body as { offers: { title: string }[] }).offers.map(o => o.title)); return { status: 200, json: {} } },
    { findExisting: async () => { throw new Error("GameBoost 503") } }
  )
  const out = await dest.publish([ITEM()], SETTINGS)
  assert.equal(created.length, 0)
  assert.equal(out[0].status, "failed")
  assert.match(out[0].error!, /Could not check GameBoost/)
})

test("publish: a sheet-log failure for recovered offers is reported, the offer is still not duplicated", async () => {
  const dest = gameboostDestination(async () => ({ status: 200, json: {} }), {
    findExisting: async () => ({ id: 9, status: "draft" }),
    logExisting: async () => { throw new Error("sheet down") },
  })
  const [r] = await dest.publish([ITEM()], SETTINGS)
  assert.equal(r.status, "created")
  assert.match(r.warning!, /sheet row could not be added: sheet down/)
})

test("no description: the seller tag '#<seller>-<link end>' is used (page, edit, and publish)", async () => {
  const [row] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "M" }], {
    readOffer: async () => ({ ...parseReal("81847225"), description: "" }),
    ai: null, game: { gameId: PUBG.id, gameSlug: PUBG.slug, gameName: PUBG.name, specs: [] }, listedTitle: () => null,
  })
  assert.equal(row.description, "#M-81847225")
  assert.ok(row.flags.some(f => f.code === "seller_tag_description"))
  assert.ok(!row.flags.some(f => f.code === "description"))
  assert.equal(revalidate({ ...row, game: PUBG, description: "" }).status, "ready", "emptied by hand is fine")
  const r = parsePublishRequest({ items: [ITEM({ description: "", seller: "M" })], settings: { deliveryDuration: 1, deliveryUnit: "hours" } })
  assert.ok(!("error" in r))
  assert.equal(r.items[0].description, "#M-81847225")
  const withDefault = parsePublishRequest({ items: [ITEM({ description: "" })], settings: { deliveryDuration: 1, deliveryUnit: "hours", defaultDescription: "Full access account." } })
  assert.ok(!("error" in withDefault) && withDefault.items[0].description === "Full access account.", "the default description wins when set")
})

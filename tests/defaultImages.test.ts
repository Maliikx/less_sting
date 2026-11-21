import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_IMG_HEADERS, MemoryDefaultImageStore, SheetDefaultImageStore, defaultImageProblem, type DefaultImageStore } from "../lib/auto/defaultImages"
import { TabConflictError } from "../lib/state/ownTab"
import { prepareBatch } from "../lib/auto/batch"
import { toPublishItem } from "../lib/auto/review"
import { funpay } from "../lib/sources/funpay"
import { fakeSpreadsheet } from "./helpers/fakeSheet"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`
const real = (id: string) => funpay.parse({ status: 200, html: readFileSync(join(__dirname, "fixtures", "real", `${id}.html`), "utf8"), finalUrl: new URL(L(id)) })
const PUBG = { gameId: 7, gameSlug: "pubg-mobile", gameName: "PUBG Mobile", specs: [] }
const IMG = "https://i.postimg.cc/AbC/pubg-default.png"

for (const [name, make] of [
  ["memory", () => new MemoryDefaultImageStore()],
  ["sheet", () => new SheetDefaultImageStore(fakeSpreadsheet().api, "DEFAULT_IMG", () => "2026-11-19")],
] as [string, () => DefaultImageStore][]) {
  test(`default images (${name}): set, replace, read back per game`, async () => {
    const s = make()
    assert.equal((await s.all()).size, 0)
    await s.set({ gameId: 7, gameName: "PUBG Mobile", url: IMG })
    await s.set({ gameId: 9, gameName: "RAID", url: "https://sfunpay.com/s/offer/a/b/raid.jpg" })
    await s.set({ gameId: 7, gameName: "PUBG Mobile", url: "https://i.postimg.cc/X/new.png" })
    const all = await s.all()
    assert.equal(all.size, 2)
    assert.equal(all.get(7)!.url, "https://i.postimg.cc/X/new.png")
  })
}

test("default images (sheet): own DEFAULT_IMG tab only, one row per game, other tabs untouched", async () => {
  const f = fakeSpreadsheet({ Sheet1: [["LINK"], ["keep"]], LS_STATE: [["KEY", "VALUE", "UPDATED_AT", "EXPIRES_AT"]] })
  const s = new SheetDefaultImageStore(f.api, "DEFAULT_IMG", () => "2026-11-19")
  await s.set({ gameId: 7, gameName: "PUBG Mobile", url: IMG })
  await s.set({ gameId: 7, gameName: "PUBG Mobile", url: IMG })
  assert.deepEqual(f.tabs.DEFAULT_IMG, [DEFAULT_IMG_HEADERS, ["7", "PUBG Mobile", IMG, "2026-11-19"]])
  assert.deepEqual(f.tabs.Sheet1, [["LINK"], ["keep"]])
  for (const r of f.touched) assert.ok(r === "add:DEFAULT_IMG" || r.startsWith("'DEFAULT_IMG'!"), `touched ${r}`)
})

test("default images (sheet): refuses a same-named tab that is not ours; ignores bad rows typed by hand", async () => {
  const foreign = fakeSpreadsheet({ DEFAULT_IMG: [["Name", "Pic"], ["x", "y"]] })
  await assert.rejects(new SheetDefaultImageStore(foreign.api).set({ gameId: 1, gameName: "x", url: IMG }), TabConflictError)
  assert.deepEqual(foreign.tabs.DEFAULT_IMG, [["Name", "Pic"], ["x", "y"]])
  const ours = fakeSpreadsheet({ DEFAULT_IMG: [DEFAULT_IMG_HEADERS, ["7", "PUBG", IMG, ""], ["abc", "bad id", IMG, ""], ["8", "imgur", "https://i.imgur.com/a.png", ""]] })
  const all = await new SheetDefaultImageStore(ours.api).all()
  assert.deepEqual([...all.keys()], [7])
})

test("default image link rules: https, no imgur", () => {
  assert.equal(defaultImageProblem(IMG), null)
  assert.match(defaultImageProblem("http://x.com/a.png")!, /https/)
  assert.match(defaultImageProblem("https://i.imgur.com/a.png")!, /imgur/)
  assert.match(defaultImageProblem("not a link")!, /https/)
})

test("pipeline: an offer without images gets its game's default image (flagged); without a default it asks for one", async () => {
  const noImages = { ...real("81849764"), images: [] }
  const run = (defaultImageFor?: (id: number) => string | null) =>
    prepareBatch([{ link: L("81849764"), price: "20", seller: "M" }], { readOffer: async () => noImages, ai: null, game: PUBG, gameFor: async () => PUBG, listedTitle: () => null, defaultImageFor })
  const [withDefault] = await run(id => (id === 7 ? IMG : null))
  assert.deepEqual(withDefault.images, [IMG])
  assert.equal(withDefault.defaultImage, true)
  assert.equal(withDefault.status, "ready")
  assert.ok(withDefault.flags.some(f => f.code === "default_image" && f.level === "warn"))
  assert.deepEqual(toPublishItem(withDefault).notes, ["default image"], "written to the sheet NOTE")

  const [without] = await run(() => null)
  assert.equal(without.status, "needs_review")
  assert.match(without.flags.find(f => f.code === "no_images")!.message, /set a default image for PUBG Mobile/)

  const [withOwn] = await prepareBatch([{ link: L("81847225"), price: "20", seller: "M" }], {
    readOffer: async () => real("81847225"), ai: null, game: PUBG, gameFor: async () => PUBG, listedTitle: () => null, defaultImageFor: () => IMG,
  })
  assert.equal(withOwn.defaultImage, undefined, "offers with their own images never get the default")
  assert.equal(withOwn.images.length, 5)
})

test("route /api/auto/default-image needs a session", async () => {
  process.env.SESSION_SECRET ||= "test-secret"
  const { GET, POST } = await import("../app/api/auto/default-image/route")
  assert.equal((await GET(new Request("http://localhost/api/auto/default-image"))).status, 401)
  assert.equal((await POST(new Request("http://localhost/api/auto/default-image", { method: "POST", body: "{}" }))).status, 401)
})

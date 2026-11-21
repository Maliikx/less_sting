import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CREDENTIALS_TEMPLATE, formatDelivery, renderCredentials } from "../lib/auto/credentials"
import { parsePublishRequest } from "../lib/auto/publishRequest"
import { buildOffersRequests } from "../lib/destinations/gameboost"
import { prepareBatch } from "../lib/auto/batch"
import { revalidate } from "../lib/auto/review"
import { readSourceOffer } from "../lib/sources/index"
import { funpay } from "../lib/sources/funpay"
import type { FetchedPage } from "../lib/sources/types"
import { formSchema } from "../app/schema"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`
const html = (id: string) => readFileSync(join(__dirname, "fixtures", "real", `${id}.html`), "utf8")
const ITEM = {
  ref: "r1", link: L("81847225"), seller: "M", title: "Blood Raven X-Suit", description: "Full access account.",
  images: ["https://sfunpay.com/s/offer/9f/ry/9fryp1oxw2cs5n0dnvtd.jpg"], priceInput: "20", accountData: {}, defaulted: [], notes: [],
  game: { id: 7, slug: "pubg-mobile", name: "PUBG Mobile" },
}

/* ------------------------------------------------------------ credentials message */

test("credentials: [delivery time] is filled from the delivery setting", () => {
  assert.equal(formatDelivery(1, "hours"), "1 hour")
  assert.equal(formatDelivery(2, "hours"), "2 hours")
  assert.equal(formatDelivery(30, "minutes"), "30 minutes")
  assert.equal(formatDelivery(1, "days"), "1 day")
  assert.equal(renderCredentials(DEFAULT_CREDENTIALS_TEMPLATE, 2, "hours"), "thank you for your purchase\n\ndelivery takes anywhere from 5 min up to 2 hours ❤️")
  assert.equal(renderCredentials("up to [delivary time] / [Delivery Time]", 1, "days"), "up to 1 day / 1 day", "spelling/case variants work")
})

test("credentials: sent with every offer of the publish, default when not set, custom text kept, max 500", () => {
  const base = { deliveryDuration: 3, deliveryUnit: "hours" }
  const def = parsePublishRequest({ items: [ITEM], settings: base })
  assert.ok(!("error" in def))
  assert.equal(def.settings.credentials, "thank you for your purchase\n\ndelivery takes anywhere from 5 min up to 3 hours ❤️")
  const custom = parsePublishRequest({ items: [ITEM], settings: { ...base, credentialsTemplate: "Thanks! Ready within [delivery time]." } })
  assert.ok(!("error" in custom) && custom.settings.credentials === "Thanks! Ready within 3 hours.")
  const long = parsePublishRequest({ items: [ITEM], settings: { ...base, credentialsTemplate: "x".repeat(501) } })
  assert.ok("error" in long && /500/.test(long.error))

  const [req] = buildOffersRequests([ITEM], { ...def.settings })
  assert.equal(req.body.offers[0].credentials, def.settings.credentials)
  assert.ok(formSchema.safeParse(req.body).success, "still valid for the existing POST /api/offers")
})

/* ------------------------------------------------------------ imgur is its own flag */

const IMGUR_PAGE = `<html><head><meta property="og:image" content="https://i.imgur.com/AbCdE12.jpg"></head></html>`
async function imgurOffer() {
  const fetcher = async (url: string): Promise<FetchedPage> =>
    url.includes("imgur.com") ? { status: 200, html: IMGUR_PAGE, finalUrl: new URL(url) } : { status: 200, html: html("62421214"), finalUrl: new URL(url) }
  return readSourceOffer(L("62421214"), fetcher) // real offer: no FunPay gallery, imgur album in the description
}
const PUBG = { gameId: 7, gameSlug: "pubg-mobile", gameName: "PUBG Mobile", specs: [] }

test("imgur: screenshots only on imgur -> 'imgur_images' (not 'no_images'), red badge data, no default image", async () => {
  const src = await imgurOffer()
  const [row] = await prepareBatch([{ link: L("62421214"), price: "20", seller: "M" }], {
    readOffer: async () => src, ai: null, game: PUBG, gameFor: async () => PUBG, listedTitle: () => null, defaultImageFor: () => "https://i.postimg.cc/x/default.png",
  })
  assert.equal(row.imgurImages, true)
  assert.deepEqual(row.images, [], "the game's default image is NOT used: real screenshots exist")
  assert.ok(row.flags.some(f => f.code === "imgur_images" && f.level === "error"))
  assert.ok(!row.flags.some(f => f.code === "no_images"))
  assert.match(row.flags.find(f => f.code === "imgur_images")!.message, /only on imgur/)

  const edited = revalidate({ ...row, game: { id: 7, slug: "pubg-mobile", name: "PUBG Mobile" }, title: row.title || "Apex account" })
  assert.ok(edited.flags.some(f => f.code === "imgur_images"), "an edit keeps the imgur flag (does not turn it into no_images)")
  const fixed = revalidate({ ...edited, images: ["https://i.postimg.cc/a/b.png"] })
  assert.ok(!fixed.flags.some(f => f.code === "imgur_images" || f.code === "no_images"), "adding image links clears it")
})

test("imgur: an offer with no images at all still gets 'no_images' and the default image", async () => {
  const src = funpay.parse({ status: 200, html: html("81849764"), finalUrl: new URL(L("81849764")) })
  const [row] = await prepareBatch([{ link: L("81849764"), price: "20", seller: "M" }], {
    readOffer: async () => src, ai: null, game: PUBG, gameFor: async () => PUBG, listedTitle: () => null, defaultImageFor: () => null,
  })
  assert.ok(!row.imgurImages)
  assert.ok(row.flags.some(f => f.code === "no_images"))
})

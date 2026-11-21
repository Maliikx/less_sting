import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyMedia, imagesFromAlbumPage, readAlbums, MAX_ALBUMS_PER_OFFER } from "../lib/sources/media"
import { readSourceOffer } from "../lib/sources/index"
import { funpay } from "../lib/sources/funpay"
import { prepareOffer } from "../lib/pipeline/prepare"
import type { FetchedPage } from "../lib/sources/types"
import { EN_OFFER } from "./fixtures"

/* Album pages below are SYNTHETIC (this container could not reach postimg/imgur). Replace with real saved pages once checked. */
const POSTIMG_PAGE = `<html><head><meta property="og:image" content="https://i.postimg.cc/AbC123xy/shot1.png"></head><body>
<img src="https://postimg.cc/logo.png"><a href="https://i.postimg.cc/AbC123xy/shot1.png?dl=1">dl</a>
<div style="background-image:url(https://i.postimg.cc/ZzZ999qq/shot2.jpg)"></div>
<script>var x={"url":"https:\\/\\/i.postimg.cc\\/QqQ777ww\\/shot3.webp"}</script></body></html>`
const IMGUR_PAGE = `<html><head><meta property="og:image" content="https://i.imgur.com/AbCdE12.jpg?fb"></head><body>
<script>{"images":[{"link":"https://i.imgur.com/XyZ9876.png"}]}</script></body></html>`

const realPage = (id: string) => readFileSync(join(__dirname, "fixtures", "real", `${id}.html`), "utf8")

/** Fake internet: url -> [status, html]; records requests. */
function net(pages: Record<string, [number, string]>) {
  const asked: string[] = []
  const fetcher = async (url: string): Promise<FetchedPage> => {
    asked.push(url)
    const hit = Object.entries(pages).find(([k]) => url.startsWith(k))
    if (!hit) throw new Error(`no fake page for ${url}`)
    return { status: hit[1][0], html: hit[1][1], finalUrl: new URL(url) }
  }
  return { fetcher, asked }
}
const noSleep = async () => {}

test("media: classify album hosts, videos and others", () => {
  assert.equal(classifyMedia("https://postimg.cc/gallery/dFBtvf7"), "postimg")
  assert.equal(classifyMedia("https://imgur.com/a/duUZpL4"), "imgur")
  assert.equal(classifyMedia("https://youtu.be/zow3l5OdzLQ"), "video")
  assert.equal(classifyMedia("https://r6skins.locker/profile/x"), "other")
  assert.equal(classifyMedia("nonsense"), "other")
})

test("media: only the album host's own image CDN links, deduped, no site logo", () => {
  assert.deepEqual(imagesFromAlbumPage("postimg", POSTIMG_PAGE), [
    "https://i.postimg.cc/AbC123xy/shot1.png",
    "https://i.postimg.cc/ZzZ999qq/shot2.jpg",
    "https://i.postimg.cc/QqQ777ww/shot3.webp",
  ])
  assert.deepEqual(imagesFromAlbumPage("imgur", IMGUR_PAGE), ["https://i.imgur.com/AbCdE12.jpg", "https://i.imgur.com/XyZ9876.png"])
  assert.deepEqual(imagesFromAlbumPage("postimg", "<html>nothing here</html>"), [])
})

test("media: imgur images are found but marked unusable (GameBoost refuses imgur)", async () => {
  const { fetcher } = net({ "https://imgur.com/": [200, IMGUR_PAGE] })
  const [r] = await readAlbums(["https://imgur.com/a/duUZpL4"], { fetcher, sleep: noSleep })
  assert.equal(r.status, "ok")
  assert.deepEqual(r.images, [])
  assert.equal(r.unusable.length, 2)
})

test("media: videos/profiles are not fetched; at most 2 albums; stops after the first usable one", async () => {
  const { fetcher, asked } = net({ "https://postimg.cc/": [200, POSTIMG_PAGE], "https://imgur.com/": [200, IMGUR_PAGE] })
  const links = ["https://youtu.be/x", "https://imgur.com/a/1", "https://postimg.cc/gallery/2", "https://postimg.cc/gallery/3", "https://imgur.com/a/4"]
  const rs = await readAlbums(links, { fetcher, sleep: noSleep })
  assert.deepEqual(asked, ["https://imgur.com/a/1", "https://postimg.cc/gallery/2"])
  assert.ok(asked.length <= MAX_ALBUMS_PER_OFFER)
  assert.equal(rs[0].status, "skipped")
  assert.equal(rs[2].images.length, 3)
  assert.ok(rs.slice(3).every(r => r.status === "skipped"))
})

test("media: album errors never throw", async () => {
  const { fetcher } = net({ "https://postimg.cc/gallery/404": [404, ""] })
  const rs = await readAlbums(["https://postimg.cc/gallery/404", "https://postimg.cc/gallery/down"], { fetcher, sleep: noSleep })
  assert.deepEqual(rs.map(r => r.status), ["error", "error"])
})

test("source: real offer without a gallery takes the postimg album's images, with a warning", async () => {
  const { fetcher, asked } = net({
    "https://funpay.com/": [200, realPage("60939088")],
    "https://postimg.cc/gallery/dFBtvf7": [200, POSTIMG_PAGE],
  })
  const o = await readSourceOffer("https://funpay.com/en/lots/offer?id=60939088", fetcher)
  assert.equal(o.images.length, 3)
  assert.equal(o.imagesFrom, "https://postimg.cc/gallery/dFBtvf7")
  assert.ok(o.warnings.some(w => /linked album/.test(w)))
  assert.equal(asked.length, 2)
})

test("source: imgur-only offer keeps no images and says why", async () => {
  const { fetcher } = net({ "https://funpay.com/": [200, realPage("62421214")], "https://imgur.com/": [200, IMGUR_PAGE] })
  const o = await readSourceOffer("https://funpay.com/en/lots/offer?id=62421214", fetcher)
  assert.equal(o.images.length, 0)
  assert.ok(o.warnings.some(w => /does not accept imgur/.test(w)))
})

test("source: offers WITH a FunPay gallery never touch album sites", async () => {
  const { fetcher, asked } = net({ "https://funpay.com/": [200, realPage("81847225")] })
  const o = await readSourceOffer("https://funpay.com/en/lots/offer?id=81847225", fetcher)
  assert.equal(o.images.length, 5)
  assert.equal(asked.length, 1)
})

test("pipeline: album images are a warning flag for review; no images at all blocks the offer", async () => {
  const { fetcher } = net({ "https://funpay.com/": [200, realPage("60939088")], "https://postimg.cc/": [200, POSTIMG_PAGE] })
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=60939088", price: "10", seller: "M" }, {
    readOffer: link => readSourceOffer(link, fetcher), ai: null, game: null,
  })
  assert.ok(r.flags.some(f => f.code === "album_images" && f.level === "warn"))
  assert.ok(!r.flags.some(f => f.code === "no_images"))

  const none = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=81849764", price: "10", seller: "M" }, {
    readOffer: async () => funpay.parse({ status: 200, html: realPage("81849764"), finalUrl: new URL("https://funpay.com/en/lots/offer?id=81849764") }),
    ai: null, game: null,
  })
  assert.equal(none.status, "needs_review")
  assert.ok(none.flags.some(f => f.code === "no_images" && f.level === "error"))
})

test("price: buyer price in USD only; a page without USD gives no price (flagged), never another currency", () => {
  const eurOnly = EN_OFFER.replace(/<option value="35"[\s\S]*?<\/option>/, "")
  const o = funpay.parse({ status: 200, html: eurOnly, finalUrl: new URL("https://funpay.com/en/lots/offer?id=123") })
  assert.equal(o.price, undefined)
  assert.equal(o.currency, undefined)
  assert.ok(o.warnings.some(w => /no USD price/.test(w)))
  const both = funpay.parse({ status: 200, html: EN_OFFER, finalUrl: new URL("https://funpay.com/en/lots/offer?id=123") })
  assert.equal(both.price, 12.5)
  assert.equal(both.currency, "USD")
})

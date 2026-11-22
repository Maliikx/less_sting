import test from "node:test"
import assert from "node:assert/strict"
import { roundPrice, roundingMessage } from "../lib/auto/pricing"
import { parsePublishRequest } from "../lib/auto/publishRequest"
import { buildOffersRequests } from "../lib/destinations/gameboost"

test("rounding: from 150 up to the next 5; under 150 unchanged (user's examples)", () => {
  assert.deepEqual(roundPrice(1223.22), { value: 1225, rounded: true, original: 1223.22 })
  assert.deepEqual(roundPrice(324), { value: 325, rounded: true, original: 324 })
  assert.deepEqual(roundPrice(556), { value: 560, rounded: true, original: 556 })
  assert.deepEqual(roundPrice(149.99), { value: 149.99, rounded: false, original: 149.99 })
  assert.deepEqual(roundPrice(37.5), { value: 37.5, rounded: false, original: 37.5 })
  assert.deepEqual(roundPrice(150), { value: 150, rounded: false, original: 150 }, "already a multiple of 5")
  assert.deepEqual(roundPrice(150.01), { value: 155, rounded: true, original: 150.01 })
  assert.deepEqual(roundPrice(325), { value: 325, rounded: false, original: 325 })
  assert.equal(roundPrice(0.1 * 3 * 1000).value, 300, "no floating-point surprise (300.00000000000006)")
  assert.equal(roundingMessage(roundPrice(749.5)), "Price rounded up 749.50 → 750 (prices from 150 round up to the next 5)")
})

const ITEM = {
  ref: "r1", link: "https://funpay.com/en/lots/offer?id=82035328", seller: "M", title: "DONATE ACCOUNT", description: "Full access.",
  images: ["https://sfunpay.com/s/offer/a/b/c.jpg"], priceInput: "x2", sourcePrice: 374.75, accountData: {}, defaulted: [], notes: [],
  game: { id: 1, slug: "fortnite", name: "Fortnite" },
}
const SET = { deliveryDuration: 1, deliveryUnit: "hours" }

test("rounding at publish: the server sends the rounded number and notes the original in the sheet", () => {
  const r = parsePublishRequest({ items: [ITEM], settings: SET })
  assert.ok(!("error" in r))
  assert.equal(r.items[0].priceInput, "750", "x2 of 374.75 = 749.50 -> 750")
  assert.deepEqual(r.items[0].notes, ["price rounded 749.50 → 750 (input x2)"])
  const [req] = buildOffersRequests(r.items, r.settings)
  assert.equal(req.body.offers[0].price, "750")
  assert.match(req.body.offers[0].note, /price rounded 749\.50 → 750 \(input x2\)/)

  const cheap = parsePublishRequest({ items: [{ ...ITEM, priceInput: "x2", sourcePrice: 40 }], settings: SET })
  assert.ok(!("error" in cheap) && cheap.items[0].priceInput === "x2" && (cheap.items[0].notes ?? []).length === 0, "80 is under 150: unchanged")

  const bad = parsePublishRequest({ items: [{ ...ITEM, sourcePrice: undefined }], settings: SET })
  assert.ok("error" in bad && /multiplier/.test(bad.error), "a multiplier without a source price is refused before GameBoost")
})

import type { PriceReader } from "../sourcePage"
import { adapterFor } from "./index"

/**
 * Price reader for the `/` form's link preview (GET /api/source/preview): for supported single-offer links
 * (FunPay) use the adapter's price = what a buyer pays in USD, never another currency. Other sites: null
 * (the generic reader is used, as before). Images and dead/blocked detection of the preview are unchanged.
 */
export const adapterPrice: PriceReader = page => {
  const a = adapterFor(page.finalUrl.href)
  if (!a || !a.adapter.canonicalId(a.url)) return null
  const o = a.adapter.parse(page)
  if (o.status !== "ok") return null
  if (o.price === undefined) return { warning: o.warnings.find(w => /price/i.test(w)) || "price not found" }
  return { price: o.price, priceText: o.priceText }
}

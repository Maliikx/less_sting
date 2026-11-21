/**
 * Offline parser check against saved real pages (no network).
 *
 *   npx tsx scripts/parser-report.ts                      (uses tests/fixtures/real)
 *   npx tsx scripts/parser-report.ts probe-output/pages   (pages saved by probe:funpay --save or /probe)
 *
 * File name = lot id (anything before the first "." or after "funpay_"); "dead-*" files are expected to be not_found.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { funpay } from "../lib/sources/funpay"

function main() {
  const dir = process.argv[2] || "tests/fixtures/real"
  const files = readdirSync(dir).filter(f => f.endsWith(".html")).sort()
  const rows: Record<string, unknown>[] = []
  const n = { ok: 0, title: 0, description: 0, images: 0, price: 0, category: 0 }
  for (const f of files) {
    const id = (f.match(/(\d{3,})/) || [])[1] || "0"
    const html = readFileSync(join(dir, f), "utf8")
    const dead = /^dead-/.test(f)
    const o = funpay.parse({ status: dead ? 404 : 200, html, finalUrl: new URL(`https://funpay.com/en/lots/offer?id=${id}`) })
    if (o.status === "ok") {
      n.ok++
      if (o.title) n.title++
      if (o.description) n.description++
      if (o.images.length) n.images++
      if (o.price !== undefined) n.price++
      if (o.category) n.category++
    }
    rows.push({
      file: f, status: o.status, title: (o.title || "").slice(0, 40), desc: (o.description || "").length, imgs: o.images.length,
      price: o.price, cur: o.currency, category: o.category, game: o.game, params: Object.keys(o.params).join("|").slice(0, 70), warn: o.warnings.join("; ").slice(0, 80),
    })
  }
  console.table(rows)
  const pct = (k: keyof typeof n) => `${Math.round((100 * n[k]) / Math.max(1, n.ok))}%`
  console.log(`ok pages ${n.ok}: title ${pct("title")}  description ${pct("description")}  images ${pct("images")}  price ${pct("price")}  category ${pct("category")}`)
}

main()

/**
 * Phase 0 check: run on YOUR machine against real FunPay links.
 *
 *   npm run probe:funpay -- links.txt            (one link per line; repeated links are checked once)
 *   npm run probe:funpay -- links.txt --save     (also saves each page to probe-output/pages/<id>.html)
 *
 * Prints how often the site answers, and for each link what the parser found. Paste the printed
 * report back so the parser labels can be corrected against the real pages.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { adapterFor } from "../lib/sources/index"
import { fetchPage } from "../lib/sourcePage"

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith("--"))
const save = args.includes("--save")
if (!file) {
  console.error("Usage: npm run probe:funpay -- links.txt [--save]")
  process.exit(1)
}

const links = [...new Set(readFileSync(file, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean))]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
if (save) mkdirSync("probe-output/pages", { recursive: true })

const rows: Record<string, unknown>[] = []
const tally = { ok: 0, not_found: 0, blocked: 0, error: 0, title: 0, description: 0, images: 0, price: 0, params: 0 }

for (const link of links) {
  const a = adapterFor(link)
  const id = a?.adapter.canonicalId(a.url)
  if (!a || !id) { console.log(`SKIP  ${link}  (not a supported single-offer link)`); continue }
  try {
    const page = await fetchPage(a.adapter.canonicalUrl(a.url))
    const o = a.adapter.parse(page)
    if (save) writeFileSync(`probe-output/pages/${id.replace(/\W+/g, "_")}.html`, page.html)
    tally[o.status]++
    if (o.status === "ok") {
      if (o.title) tally.title++
      if (o.description) tally.description++
      if (o.images.length) tally.images++
      if (o.price !== undefined) tally.price++
      if (Object.keys(o.params).length) tally.params++
    }
    rows.push({
      id, http: o.httpStatus, status: o.status, title: (o.title || "").slice(0, 70), descChars: (o.description || "").length,
      images: o.images.length, price: o.priceText, params: Object.keys(o.params).join(" | "), category: o.category, warnings: o.warnings.join("; "), message: o.message,
    })
  } catch (e) {
    tally.error++
    rows.push({ id, status: "error", message: e instanceof Error ? e.message : String(e) })
  }
  await sleep(1500) // be polite: ~1 request per 1.5 s
}

console.table(rows)
const okN = tally.ok || 1
console.log(`
Links checked: ${links.length}
  page read OK : ${tally.ok}   not found: ${tally.not_found}   blocked: ${tally.blocked}   errors: ${tally.error}
  Of the ${tally.ok} readable pages: title ${tally.title}, description ${tally.description}, images ${tally.images}, price ${tally.price}, params ${tally.params}
  Hit rates: title ${Math.round((100 * tally.title) / okN)}%  description ${Math.round((100 * tally.description) / okN)}%  images ${Math.round((100 * tally.images) / okN)}%  price ${Math.round((100 * tally.price) / okN)}%
`)
mkdirSync("probe-output", { recursive: true })
writeFileSync("probe-output/report.json", JSON.stringify({ tally, rows }, null, 2))
console.log("Full report saved to probe-output/report.json")

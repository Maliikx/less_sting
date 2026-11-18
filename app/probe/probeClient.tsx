"use client"

import { useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import NavBar from "../navBar"
import { dedupeLinks, PROBE_GAP_MS, PROBE_MAX_LINKS, summarize, type ProbeRow } from "@/lib/sources/probe"

/** Stop on our own when this many links in a row come back blocked: never push harder against a block. */
const STOP_AFTER_BLOCKED_IN_A_ROW = 3

const statusColor: Record<string, string> = {
  ok: "bg-green-700",
  not_found: "bg-neutral-500",
  blocked: "bg-red-700",
  error: "bg-yellow-700",
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const fileName = (row: ProbeRow) => `${(row.lotId || "page").replace(/\W+/g, "_")}.html`

export default function ProbeClient() {
  const [input, setInput] = useState("")
  const [keepHtml, setKeepHtml] = useState(true)
  const [rows, setRows] = useState<ProbeRow[]>([])
  const [repeated, setRepeated] = useState<string[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stoppedReason, setStoppedReason] = useState<string | null>(null)
  const stopRef = useRef(false)
  // HTML can be large: keep it out of React state.
  const htmlRef = useRef(new Map<string, string>())

  const run = async () => {
    const { links, repeated } = dedupeLinks(input.split(/\r?\n/))
    if (!links.length) return
    stopRef.current = false
    htmlRef.current.clear()
    setRows([])
    setRepeated(repeated)
    setError(null)
    setStoppedReason(null)
    setRunning(true)
    setProgress({ done: 0, total: links.length })

    let blockedInARow = 0
    const all: ProbeRow[] = []
    try {
      for (let i = 0; i < links.length; i += PROBE_MAX_LINKS) {
        if (stopRef.current) {
          setStoppedReason("Stopped by you.")
          break
        }
        if (i > 0) await sleep(PROBE_GAP_MS) // the server spaces requests inside a chunk; this spaces the chunks
        const chunk = links.slice(i, i + PROBE_MAX_LINKS)
        const res = await fetch("/api/source/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ links: chunk, includeHtml: keepHtml }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        for (const r of data.rows as ProbeRow[]) {
          if (r.html !== undefined) htmlRef.current.set(r.link, r.html)
          const { html: _html, ...lean } = r
          void _html
          all.push(lean)
          blockedInARow = r.status === "blocked" ? blockedInARow + 1 : 0
        }
        setRows([...all])
        setProgress({ done: all.length, total: links.length })
        if (blockedInARow >= STOP_AFTER_BLOCKED_IN_A_ROW) {
          setStoppedReason(`Stopped: ${blockedInARow} links in a row were blocked by the site. Do not retry faster; see plan B/C.`)
          break
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const s = summarize(rows)
  const report = () =>
    download(`probe-report-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`, JSON.stringify({ summary: s, rows }, null, 2), "application/json")

  return (
    <div className="w-full max-w-[1400px] p-4">
      <NavBar active="probe" />
      <Card className="bg-[#2b2b2b] border-neutral-700 text-white">
        <CardHeader>
          <CardTitle>Source probe</CardTitle>
          <CardDescription className="text-neutral-400">
            Reads FunPay offer pages from this server to check the parser and whether the site blocks us. Read-only: nothing is listed
            or written to the sheet. One request every {PROBE_GAP_MS / 1000} s.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="One FunPay offer link per line"
            rows={8}
            className="bg-[#1e1e1e] border-neutral-700 font-mono text-xs"
            disabled={running}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={running || !input.trim()}>
              {running ? "Probing…" : "Probe links"}
            </Button>
            {running && (
              <Button variant="secondary" onClick={() => (stopRef.current = true)}>
                Stop after this chunk
              </Button>
            )}
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="checkbox" checked={keepHtml} onChange={e => setKeepHtml(e.target.checked)} disabled={running} />
              Keep page HTML for download
            </label>
            {rows.length > 0 && !running && (
              <Button variant="outline" className="text-black" onClick={report}>
                Download report (JSON)
              </Button>
            )}
          </div>

          {progress && (
            <div>
              <div className="h-2 w-full rounded bg-neutral-700">
                <div className="h-2 rounded bg-green-600 transition-all" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
              </div>
              <p className="mt-1 text-xs text-neutral-400">
                {progress.done} / {progress.total} links
                {repeated.length > 0 && ` · ${repeated.length} repeated link(s) skipped`}
              </p>
            </div>
          )}

          {error && <p className="rounded bg-red-900/60 p-2 text-sm">Error: {error}</p>}
          {stoppedReason && <p className="rounded bg-yellow-900/60 p-2 text-sm">{stoppedReason}</p>}
          {s.byStatus.blocked > 0 && (
            <p className="rounded bg-red-900/60 p-2 text-sm">
              {s.byStatus.blocked} of {s.total} pages were blocked by the site (HTTP 403/429 or a captcha). Do not speed up or retry in a
              loop. Report this before going further.
            </p>
          )}

          {rows.length > 0 && (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-8">
              {[
                ["OK", s.byStatus.ok],
                ["Not found", s.byStatus.not_found],
                ["Blocked", s.byStatus.blocked],
                ["Errors", s.byStatus.error],
                ["Title", `${s.hitRates.title}%`],
                ["Description", `${s.hitRates.description}%`],
                ["Images", `${s.hitRates.images}%`],
                ["Price", `${s.hitRates.price}%`],
              ].map(([k, v]) => (
                <div key={k} className="rounded bg-[#1e1e1e] p-2">
                  <div className="text-xs text-neutral-400">{k}</div>
                  <div className="text-lg font-semibold">{v}</div>
                </div>
              ))}
              <p className="col-span-full text-xs text-neutral-400">Hit rates are out of the {s.byStatus.ok} pages that were read OK.</p>
            </div>
          )}

          {repeated.length > 0 && (
            <details className="text-xs text-neutral-400">
              <summary>Repeated links (checked once)</summary>
              <ul className="mt-1 font-mono">{repeated.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </details>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-neutral-400">
                  <tr>
                    {["Lot id", "Status", "HTTP", "Game", "Title", "Desc", "Imgs", "Price", "Params", "Warnings / message", "HTML"].map(h => (
                      <th key={h} className="whitespace-nowrap border-b border-neutral-700 p-1.5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const html = htmlRef.current.get(r.link)
                    return (
                      <tr key={r.link} className="align-top border-b border-neutral-800">
                        <td className="whitespace-nowrap p-1.5 font-mono">
                          <a href={r.link} target="_blank" rel="noreferrer" className="underline">{r.lotId || r.link}</a>
                        </td>
                        <td className="p-1.5"><span className={`rounded px-1.5 py-0.5 ${statusColor[r.status]}`}>{r.status}</span></td>
                        <td className="p-1.5">{r.httpStatus ?? ""}</td>
                        <td className="max-w-[140px] p-1.5 text-neutral-300">{r.game || r.category || ""}</td>
                        <td className="max-w-[260px] p-1.5">{r.title}</td>
                        <td className="p-1.5">{r.descriptionChars || ""}</td>
                        <td className="p-1.5">{r.status === "ok" ? r.images : ""}</td>
                        <td className="whitespace-nowrap p-1.5">{r.priceText ?? ""}</td>
                        <td className="max-w-[260px] p-1.5 text-neutral-300">{r.params.join(" | ")}</td>
                        <td className="max-w-[220px] p-1.5 text-yellow-300">{[...r.warnings, r.message].filter(Boolean).join("; ")}</td>
                        <td className="p-1.5">
                          {html !== undefined && (
                            <button type="button" className="underline" onClick={() => download(fileName(r), html, "text/html")}>
                              .html
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

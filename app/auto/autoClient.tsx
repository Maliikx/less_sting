"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import NavBar from "../navBar"
import { EMPLOYEES } from "@/lib/employees"
import { revalidate, toPublishItem, type ReviewRow } from "@/lib/auto/review"
import {
  actionTargets, canPublishRow, isSelectable, newRow, pruneSelection, rowProblem, rowsFromPaste, rowsToPrepare,
  selectAll, selectCreated, selectReady, type InputRow, type ResultRow,
} from "@/lib/auto/rows"
import { diffWords, titleChanged } from "@/lib/auto/diff"
import { defaultImageProblem } from "@/lib/auto/defaultImages"
import { descriptionTag } from "@/lib/offerRules"
import type { PublishResult } from "@/lib/destinations/types"
import type { GameRef } from "@/lib/auto/games"

const CHUNK = 8 // /api/ai/prepare max (the server reads pages 1.5 s apart, 3 offers in flight)
const PUBLISH_CHUNK = 5 // small calls finish well inside the function time limit (a 20-offer call timed out once)
const GAP_MS = 1500 // between prepare calls (FunPay: ~1 page read per 1.5 s)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Settings = {
  seller: string
  deliveryDuration: string
  deliveryUnit: "minutes" | "hours" | "days"
  defaultDescription: string
  deliveryInstructions: string
  listNow: boolean
}
const DEFAULT_SETTINGS: Settings = { seller: "", deliveryDuration: "1", deliveryUnit: "hours", defaultDescription: "", deliveryInstructions: "", listNow: false }
const SETTINGS_KEY = "ls-auto-settings-v3"

const STATUS: Record<string, { label: string; cls: string; help: string }> = {
  ready: { label: "ready", cls: "bg-green-700", help: "Checked and cleaned. Can be published." },
  needs_review: { label: "check", cls: "bg-yellow-700", help: "Something needs you (see the yellow note). Fix it in the row details." },
  duplicate: { label: "duplicate", cls: "bg-neutral-600", help: "The same title is already in the sheet or earlier in this batch." },
  dead: { label: "dead", cls: "bg-neutral-700", help: "The offer no longer exists on FunPay." },
  blocked: { label: "blocked", cls: "bg-red-800", help: "FunPay did not answer. Try again later." },
  error: { label: "error", cls: "bg-red-700", help: "The page could not be read." },
  draft: { label: "draft", cls: "bg-blue-700", help: "Created on GameBoost, hidden (not for sale)." },
  listed: { label: "listed", cls: "bg-emerald-600", help: "On sale on GameBoost." },
  deleted: { label: "deleted", cls: "bg-neutral-700 line-through", help: "Deleted from GameBoost; sheet row marked deleted." },
  failed: { label: "publish failed", cls: "bg-red-700", help: "GameBoost or the sheet refused it (see the red note)." },
}

function statusOf(r: ResultRow) {
  if (r.deleted) return "deleted"
  if (r.result?.status === "created") return r.result.offerStatus === "listed" ? "listed" : "draft"
  if (r.result?.status === "duplicate") return "duplicate"
  if (r.result?.status === "failed") return "failed"
  return r.status
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as T
}

const inputCls = "border-neutral-600 bg-neutral-200 text-neutral-900"

function Steps({ at }: { at: number }) {
  const steps = ["Your offers", "Prepare: read + clean", "Review", "Publish"]
  return (
    <ol className="flex flex-wrap gap-1 text-xs">
      {steps.map((s, i) => (
        <li key={s} className={`rounded-full px-3 py-1 ${i + 1 === at ? "bg-white font-semibold text-black" : i + 1 < at ? "bg-neutral-600 text-neutral-200" : "bg-neutral-800 text-neutral-400"}`}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  )
}

/** Cleaned title, and under it the original with what cleaning removed struck through in red. */
function TitleCell({ row }: { row: ResultRow }) {
  const original = row.original.title || ""
  const changed = !!original && !!row.title && titleChanged(original, row.title)
  return (
    <div>
      <div className="truncate font-medium text-white" title={row.title}>{row.title || row.link}</div>
      {changed && (
        <div className="truncate text-[11px] text-neutral-400" title={`Original: ${original}`}>
          <span className="mr-1 rounded bg-neutral-700 px-1 text-[10px] uppercase tracking-wide">original</span>
          {diffWords(original, row.title).map((p, i) =>
            p.kind === "added" ? null : (
              <span key={i} className={p.kind === "removed" ? "text-red-400 line-through" : ""}>{p.text} </span>
            )
          )}
        </div>
      )}
    </div>
  )
}

export default function AutoClient() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [inputs, setInputs] = useState<InputRow[]>(() => Array.from({ length: 5 }, () => newRow()))
  const [bulkPrice, setBulkPrice] = useState("")
  const [paste, setPaste] = useState("")
  const [showPaste, setShowPaste] = useState(false)
  const [rows, setRows] = useState<ResultRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | { what: string; done: number; total: number }>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  /* ---- settings (incl. the seller), remembered per browser ---- */
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")
      if (saved && typeof saved === "object") setSettings({ ...DEFAULT_SETTINGS, ...saved })
    } catch {
      /* storage unavailable */
    }
  }, [])
  const saveSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  /* ---- step 1: input rows ---- */
  const toPrepare = useMemo(() => rowsToPrepare(inputs, settings.seller), [inputs, settings.seller])
  const filled = inputs.filter(r => r.link.trim()).length
  const setInput = (id: string, patch: Partial<InputRow>) => setInputs(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)))
  const addPasted = () => {
    const added = rowsFromPaste(paste, bulkPrice.trim())
    if (!added.length) return
    setInputs(prev => [...prev.filter(r => r.link.trim()), ...added])
    setPaste("")
    setShowPaste(false)
  }

  /* ---- results helpers ---- */
  const updateRows = (fn: (prev: ResultRow[]) => ResultRow[]) =>
    setRows(prev => {
      const next = fn(prev)
      setSelected(sel => pruneSelection(next, sel))
      return next
    })
  const patchRow = (key: string, patch: Partial<ResultRow>) => updateRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  const edit = (key: string, patch: Partial<ResultRow>) =>
    updateRows(prev => prev.map(r => (r.key === key ? { ...(revalidate({ ...r, ...patch } as ReviewRow) as ResultRow), key, result: r.result } : r)))

  /** Step 2: prepare in chunks; `picks` = categoryId -> game chosen by the user. Rows with the same key are replaced. */
  async function prepare(lines: { key: string; link: string; price: string; seller: string }[], picks: Record<string, GameRef> = {}) {
    setError(null)
    setBusy({ what: "Reading and cleaning offers", done: 0, total: lines.length })
    try {
      for (let i = 0; i < lines.length; i += CHUNK) {
        if (i > 0) await sleep(GAP_MS)
        const chunk = lines.slice(i, i + CHUNK)
        const data = await postJson<{ results: ReviewRow[] }>("/api/ai/prepare", {
          items: chunk.map(({ link, price, seller }) => ({ link, price, seller })),
          picks,
          defaultDescription: settings.defaultDescription || undefined,
        })
        const fresh: ResultRow[] = data.results.map((r, j) => ({ ...r, key: chunk[j].key }))
        updateRows(prev => {
          const map = new Map(prev.map(r => [r.key, r]))
          for (const r of fresh) map.set(r.key, r)
          return [...map.values()]
        })
        setSelected(prev => new Set([...prev, ...fresh.filter(canPublishRow).map(r => r.key)]))
        setBusy({ what: "Reading and cleaning offers", done: Math.min(lines.length, i + chunk.length), total: lines.length })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const start = () => {
    setRows([])
    setSelected(new Set())
    setOpen(null)
    setNotice(null)
    void prepare(toPrepare)
  }

  /* ---- step 3 helpers: unknown games, missing images ---- */
  const unknown = useMemo(() => {
    const m = new Map<string, { category: string; keys: string[] }>()
    for (const r of rows) {
      if (r.result || r.game || !r.categoryId || !r.flags.some(f => f.code === "game_unknown")) continue
      const g = m.get(r.categoryId) || { category: r.category || r.categoryId, keys: [] }
      g.keys.push(r.key)
      m.set(r.categoryId, g)
    }
    return [...m.entries()]
  }, [rows])
  const applyGame = (categoryId: string, game: GameRef) => {
    const keys = unknown.find(([id]) => id === categoryId)?.[1].keys || []
    void prepare(rows.filter(r => keys.includes(r.key)).map(r => ({ key: r.key, link: r.link, price: r.priceInput, seller: r.seller })), { [categoryId]: game })
  }

  const noImages = useMemo(() => {
    const m = new Map<number, { game: NonNullable<ResultRow["game"]>; keys: string[] }>()
    for (const r of rows) {
      if (r.result || !r.game || r.images.length || r.status === "duplicate" || r.status === "dead") continue
      const g = m.get(r.game.id) || { game: r.game, keys: [] }
      g.keys.push(r.key)
      m.set(r.game.id, g)
    }
    return [...m.values()]
  }, [rows])
  async function saveDefaultImage(game: NonNullable<ResultRow["game"]>, url: string) {
    await postJson("/api/auto/default-image", { gameId: game.id, gameName: game.name, url })
    updateRows(prev =>
      prev.map(r => {
        if (r.result || r.game?.id !== game.id || r.images.length) return r
        const flags = [...r.flags.filter(f => f.code !== "default_image"), { level: "warn" as const, code: "default_image", message: `No images on the offer: the default image for ${game.name} is used` }]
        return { ...(revalidate({ ...r, images: [url], defaultImage: true, flags } as ReviewRow) as ResultRow), key: r.key }
      })
    )
    setNotice(`Default image saved for ${game.name}. It is used from now on for ${game.name} offers without images.`)
  }

  /* ---- step 4: actions on ticked rows ---- */
  const targets = actionTargets(rows, selected)

  async function publish() {
    const list = targets.publish
    if (!list.length) return
    const mode = settings.listNow ? "LISTED for sale right away" : "created as hidden DRAFTS"
    if (!window.confirm(`Publish ${list.length} offer(s) to GameBoost for seller ${list[0].seller}? They will be ${mode} and logged to the sheet.`)) return
    setError(null)
    setNotice(null)
    setBusy({ what: "Publishing", done: 0, total: list.length })
    let created = 0
    try {
      for (let i = 0; i < list.length; i += PUBLISH_CHUNK) {
        const chunk = list.slice(i, i + PUBLISH_CHUNK)
        const data = await postJson<{ results: PublishResult[] }>("/api/auto/publish", {
          items: chunk.map(r => toPublishItem(r)),
          settings: {
            listNow: settings.listNow,
            deliveryDuration: Number(settings.deliveryDuration),
            deliveryUnit: settings.deliveryUnit,
            defaultDescription: settings.defaultDescription || undefined,
            deliveryInstructions: settings.deliveryInstructions || undefined,
          },
        })
        const byRef = new Map(data.results.map(r => [r.ref, r]))
        created += data.results.filter(r => r.status === "created").length
        updateRows(prev => prev.map(r => (byRef.has(r.key) ? { ...r, result: byRef.get(r.key) } : r)))
        setBusy({ what: "Publishing", done: Math.min(list.length, i + chunk.length), total: list.length })
      }
      setNotice(`${created} offer(s) ${settings.listNow ? "listed" : "created as drafts"} on GameBoost.`)
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : String(e)}. Some offers may already be on GameBoost. It is safe to press Publish again: ` +
          "offers that already exist are found by title and only their sheet row is added, they are not created twice."
      )
    } finally {
      setBusy(null)
    }
  }

  /** One GameBoost call per offer, one after another (stays far below the write limits). */
  async function runOnOffers(list: ResultRow[], what: string, call: (r: ResultRow) => Promise<Partial<ResultRow>>) {
    setError(null)
    setNotice(null)
    setBusy({ what, done: 0, total: list.length })
    let ok = 0
    for (const [i, r] of list.entries()) {
      patchRow(r.key, { busy: true, actionError: undefined })
      try {
        patchRow(r.key, { ...(await call(r)), busy: false })
        ok++
      } catch (e) {
        patchRow(r.key, { busy: false, actionError: e instanceof Error ? e.message : String(e) })
      }
      setBusy({ what, done: i + 1, total: list.length })
    }
    setBusy(null)
    setNotice(`${what}: ${ok} of ${list.length} done${ok < list.length ? " (see the red notes in the table)" : ""}.`)
  }

  const setVisibility = (list: ResultRow[], action: "list" | "unlist") =>
    runOnOffers(list, action === "list" ? "Listing" : "Moving back to draft", async r => {
      const data = await postJson<{ offer?: { status?: string } }>(`/api/gameboost/offers/${r.result!.offerId}/visibility`, { action })
      return { result: { ...r.result!, offerStatus: data.offer?.status || (action === "list" ? "listed" : "draft") } }
    })

  async function remove(list: ResultRow[]) {
    if (!list.length) return
    if (!window.confirm(`PERMANENTLY delete ${list.length} offer(s) from GameBoost? Their sheet rows are kept and marked "deleted". This cannot be undone.`)) return
    await runOnOffers(list, "Deleting", async r => {
      const res = await fetch(`/api/gameboost/offers/${r.result!.offerId}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return { deleted: true, actionError: data.sheetWarning }
    })
  }

  /* ---- render ---- */
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[statusOf(r)] = (m[statusOf(r)] || 0) + 1), m), {})
  const selectable = rows.filter(isSelectable)
  const allTicked = selectable.length > 0 && selectable.every(r => selected.has(r.key))
  const toggle = (key: string, on: boolean) => setSelected(s => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n })
  const step = rows.some(r => r.result) ? 4 : rows.length ? 3 : busy ? 2 : 1
  const cleanedCount = rows.filter(r => r.original.title && titleChanged(r.original.title, r.title)).length

  return (
    <section className="flex w-full max-w-[1300px] justify-center px-4 py-10">
      <Card className="w-full border-0 bg-neutral-700/70">
        <CardHeader className="space-y-3 border-b border-b-neutral-400">
          <NavBar active="auto" />
          <div>
            <CardTitle className="text-white">Batch listing</CardTitle>
            <CardDescription>Paste FunPay offers with a price. The app reads each offer, cleans the title and description, and fills the game details. You review, then publish.</CardDescription>
          </div>
          <Steps at={step} />
        </CardHeader>

        <CardContent className="space-y-5 pt-4 text-white">
          {/* ================= 1. your offers ================= */}
          <div className="space-y-3 rounded-lg border border-neutral-600 bg-neutral-800/60 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-sm font-semibold text-neutral-200">Seller (you)</label>
                <Select value={settings.seller} onValueChange={v => saveSettings({ seller: v })}>
                  <SelectTrigger className={`${inputCls} w-36 ${settings.seller ? "" : "ring-2 ring-yellow-500"}`}><SelectValue placeholder="Choose seller" /></SelectTrigger>
                  <SelectContent className="bg-neutral-200">{EMPLOYEES.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-sm text-neutral-300">Price for all</label>
                <Input className={inputCls} placeholder="e.g. 100 or x2" value={bulkPrice} onChange={e => setBulkPrice(e.target.value)} />
              </div>
              <Button type="button" variant="secondary" disabled={!bulkPrice.trim()} onClick={() => setInputs(prev => prev.map(r => ({ ...r, price: bulkPrice.trim() })))}>Apply price to all</Button>
              <Button type="button" variant="secondary" onClick={() => setInputs(prev => [...prev, ...Array.from({ length: 10 }, () => newRow())])}>➕ Add 10 rows</Button>
              <Button type="button" variant="secondary" onClick={() => setShowPaste(v => !v)}>📋 Paste many links</Button>
            </div>
            {!settings.seller && <p className="text-xs text-yellow-300">Choose your seller code first: every offer in this batch is listed under it.</p>}

            {showPaste && (
              <div className="space-y-2 rounded-lg border border-neutral-600 bg-neutral-900 p-3">
                <p className="text-xs text-neutral-400">One link per line, optionally followed by its price. Lines without a price use &quot;Price for all&quot;.</p>
                <Textarea className="bg-neutral-200 font-mono text-xs text-neutral-900" rows={6} value={paste} onChange={e => setPaste(e.target.value)} placeholder={"https://funpay.com/en/lots/offer?id=81847225 x1.5\nhttps://funpay.com/en/lots/offer?id=81843891"} />
                <Button type="button" onClick={addPasted} disabled={!paste.trim()}>Add these rows</Button>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="hidden grid-cols-[2rem_1fr_9rem_2rem] gap-2 px-1 text-xs text-neutral-400 sm:grid">
                <span>#</span><span>FunPay offer link</span><span>Price (or x2)</span><span />
              </div>
              {inputs.map((r, i) => {
                const problem = rowProblem(r)
                return (
                  <div key={r.id} className={`grid grid-cols-[2rem_1fr] gap-2 rounded-lg border bg-neutral-900 p-2 sm:grid-cols-[2rem_1fr_9rem_2rem] ${problem ? "border-yellow-600" : "border-neutral-700"}`}>
                    <span className="pt-2 text-xs text-neutral-500">{i + 1}</span>
                    <div>
                      <Input className={inputCls} placeholder="https://funpay.com/en/lots/offer?id=..." value={r.link} onChange={e => setInput(r.id, { link: e.target.value })} />
                      {problem && <p className="mt-1 text-xs text-yellow-300">⚠ {problem}</p>}
                    </div>
                    <Input className={`${inputCls} col-start-2 sm:col-start-auto`} placeholder="100 or x2" value={r.price} onChange={e => setInput(r.id, { price: e.target.value })} />
                    <button type="button" title="Remove row" className="col-start-2 text-neutral-400 hover:text-red-400 sm:col-start-auto" onClick={() => setInputs(prev => (prev.length > 1 ? prev.filter(x => x.id !== r.id) : [newRow()]))}>✕</button>
                  </div>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-neutral-700 pt-3">
              <Button onClick={start} disabled={!!busy || !toPrepare.length} className="bg-sky-600 hover:bg-sky-500">
                Prepare {toPrepare.length || ""} offer{toPrepare.length === 1 ? "" : "s"}
              </Button>
              <span className="text-xs text-neutral-400">
                Reads each FunPay page, removes banned words / contacts / ads / seller talk from the title and description, checks duplicates by the original title, fills the game details.
                {filled > toPrepare.length && settings.seller ? ` ${filled - toPrepare.length} row(s) skipped (see warnings).` : ""}
              </span>
              <button type="button" className="ml-auto text-xs text-neutral-400 underline" onClick={() => setInputs(Array.from({ length: 5 }, () => newRow()))}>Clear rows</button>
            </div>
          </div>

          {busy && (
            <div>
              <div className="h-2 w-full rounded bg-neutral-600"><div className="h-2 rounded bg-green-500 transition-all" style={{ width: `${(100 * busy.done) / Math.max(1, busy.total)}%` }} /></div>
              <p className="mt-1 text-xs text-neutral-300">{busy.what}… {busy.done} / {busy.total}</p>
            </div>
          )}
          {error && <p className="rounded bg-red-950/60 p-2 text-sm text-red-200">{error}</p>}
          {notice && <p className="rounded bg-sky-950/60 p-2 text-sm text-sky-200">{notice}</p>}

          {/* ================= 3. needs you: games, images ================= */}
          {unknown.length > 0 && (
            <div className="space-y-2 rounded-lg border border-yellow-700 bg-yellow-950/40 p-3 text-sm">
              <p className="font-semibold">Which GameBoost game? <span className="font-normal text-neutral-300">(asked once per FunPay category, then remembered)</span></p>
              {unknown.map(([id, g]) => <GamePicker key={id} category={g.category} count={g.keys.length} disabled={!!busy} onPick={game => applyGame(id, game)} />)}
            </div>
          )}
          {noImages.length > 0 && (
            <div className="space-y-2 rounded-lg border border-yellow-700 bg-yellow-950/40 p-3 text-sm">
              <p className="font-semibold">Offers without images <span className="font-normal text-neutral-300">(set a default image once per game; it is saved in the sheet&apos;s DEFAULT_IMG tab and used from now on)</span></p>
              {noImages.map(g => <DefaultImageInput key={g.game.id} game={g.game} count={g.keys.length} disabled={!!busy} onSave={url => saveDefaultImage(g.game, url)} />)}
            </div>
          )}

          {/* ================= 3. review  +  4. publish ================= */}
          {rows.length > 0 && (
            <div className="space-y-3 rounded-lg border border-neutral-600 bg-neutral-900 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {Object.entries(counts).map(([k, n]) => (
                  <span key={k} title={STATUS[k]?.help} className={`cursor-help rounded px-2 py-0.5 ${STATUS[k]?.cls || "bg-neutral-700"}`}>{STATUS[k]?.label || k} {n}</span>
                ))}
                <span className="text-neutral-400">· hover a status to see what it means</span>
              </div>
              <p className="rounded bg-neutral-800 px-2 py-1.5 text-xs text-neutral-300">
                <b>Titles were cleaned during Prepare</b> ({cleanedCount} of {rows.length} changed). The white line is what will be listed; under it, the
                original FunPay title with removed words <span className="text-red-400 line-through">struck through in red</span> (banned words, site names,
                contacts, ads). Click a row to see the description, removed sentences and game details, and to edit before publishing.
              </p>

              {/* publish settings, next to the publish buttons */}
              <div className="rounded border border-neutral-700 bg-neutral-800/60 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Publishing:</span>
                  <div className="flex overflow-hidden rounded-md border border-neutral-600">
                    {[{ v: false, t: "Create as draft" }, { v: true, t: "List immediately" }].map(o => (
                      <button key={o.t} type="button" onClick={() => saveSettings({ listNow: o.v })}
                        className={`px-3 py-1.5 ${settings.listNow === o.v ? (o.v ? "bg-emerald-600 font-semibold" : "bg-sky-600 font-semibold") : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}>
                        {o.t}
                      </button>
                    ))}
                  </div>
                  <span className="text-neutral-300">delivery {settings.deliveryDuration} {settings.deliveryUnit} · seller {settings.seller || "—"}</span>
                  <button type="button" className="underline" onClick={() => setShowSettings(v => !v)}>{showSettings ? "hide settings" : "change settings"}</button>
                </div>
                {showSettings && (
                  <div className="mt-2 grid gap-2 md:grid-cols-[auto_1fr]">
                    <label className="flex items-center gap-2">Guaranteed delivery
                      <Input className={`${inputCls} h-8 w-16`} inputMode="numeric" value={settings.deliveryDuration} onChange={e => saveSettings({ deliveryDuration: e.target.value.replace(/\D/g, "") })} />
                      <Select value={settings.deliveryUnit} onValueChange={v => saveSettings({ deliveryUnit: v as Settings["deliveryUnit"] })}>
                        <SelectTrigger className={`${inputCls} h-8 w-28`}><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-neutral-200">{["minutes", "hours", "days"].map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                      </Select>
                    </label>
                    <Input className={`${inputCls} h-8`} placeholder={`Default description (empty = just the seller tag, e.g. ${descriptionTag(settings.seller || "M", "81847225")})`} value={settings.defaultDescription} onChange={e => saveSettings({ defaultDescription: e.target.value })} />
                    <label className="md:col-span-2">Delivery instructions <span className="text-neutral-400">(shown to the buyer after purchase; NOT encrypted, never passwords)</span>
                      <Textarea className={inputCls} rows={2} value={settings.deliveryInstructions} onChange={e => saveSettings({ deliveryInstructions: e.target.value })} />
                    </label>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSelected(selectReady(rows))} disabled={!rows.some(canPublishRow)}>Select all ready ({rows.filter(canPublishRow).length})</Button>
                <Button variant="secondary" size="sm" onClick={() => setSelected(selectCreated(rows))} disabled={!selectCreated(rows).size}>Select created ({selectCreated(rows).size})</Button>
                <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())} disabled={!selected.size}>Select none</Button>
                <span className="mx-1 h-5 w-px bg-neutral-600" />
                <Button size="sm" onClick={publish} disabled={!!busy || !targets.publish.length} className="bg-sky-600 hover:bg-sky-500">
                  Publish {settings.listNow ? "& list" : "as draft"} ({targets.publish.length})
                </Button>
                <Button size="sm" onClick={() => setVisibility(targets.listNow, "list")} disabled={!!busy || !targets.listNow.length} className="bg-emerald-600 hover:bg-emerald-500">List now ({targets.listNow.length})</Button>
                <Button size="sm" variant="secondary" onClick={() => setVisibility(targets.unlist, "unlist")} disabled={!!busy || !targets.unlist.length}>Back to draft ({targets.unlist.length})</Button>
                <Button size="sm" onClick={() => remove(targets.remove)} disabled={!!busy || !targets.remove.length} className="bg-red-700 hover:bg-red-600">Delete ({targets.remove.length})</Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left text-xs">
                  <colgroup><col className="w-8" /><col className="w-24" /><col /><col className="w-28" /><col className="w-16" /><col className="w-32" /><col className="w-36" /></colgroup>
                  <thead className="text-neutral-400">
                    <tr>
                      <th className="border-b border-neutral-700 p-1.5"><input type="checkbox" aria-label="Select all" checked={allTicked} disabled={!selectable.length} onChange={e => setSelected(e.target.checked ? selectAll(rows) : new Set())} /></th>
                      {["Status", "Title (cleaned · original)", "Price", "Images", "Game", "Notes"].map(h => <th key={h} className="whitespace-nowrap border-b border-neutral-700 p-1.5">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const st = STATUS[statusOf(r)]
                      const errors = r.flags.filter(f => f.level === "error")
                      const isOpen = open === r.key
                      return (
                        <Fragment key={r.key}>
                          <tr className={`cursor-pointer border-b border-neutral-800 align-top hover:bg-neutral-800/60 ${isOpen ? "bg-neutral-800/60" : ""}`} onClick={() => setOpen(isOpen ? null : r.key)}>
                            <td className="p-1.5" onClick={e => e.stopPropagation()}>
                              <input type="checkbox" disabled={!isSelectable(r) || r.busy} checked={selected.has(r.key)} onChange={e => toggle(r.key, e.target.checked)} />
                            </td>
                            <td className="p-1.5"><span title={st?.help} className={`whitespace-nowrap rounded px-1.5 py-0.5 ${st?.cls}`}>{r.busy ? "working…" : st?.label}</span></td>
                            <td className="p-1.5">
                              <TitleCell row={r} />
                              {r.result?.offerId && <div className="text-sky-300">GameBoost #{r.result.offerId}</div>}
                              {(r.result?.error || r.result?.warning) && <div className="text-red-300">{r.result.error || r.result.warning}</div>}
                              {r.actionError && <div className="text-red-300">{r.actionError}</div>}
                              {!r.result && errors[0] && <div className="text-yellow-300">⚠ {errors[0].message}{errors.length > 1 ? ` (+${errors.length - 1} more, click)` : ""}</div>}
                              {!r.result && !errors[0] && r.status !== "ready" && r.flags[0] && <div className="text-neutral-400">{r.flags[0].message}</div>}
                            </td>
                            <td className="whitespace-nowrap p-1.5">
                              {r.priceEur !== undefined ? <b>{r.priceEur.toFixed(2)}</b> : "—"}
                              <div className="text-neutral-500">{r.priceInput}{r.priceText ? ` of ${r.priceText}` : ""}</div>
                            </td>
                            <td className="p-1.5">
                              {r.images.length}
                              {r.albumImages && <div><span className="rounded bg-yellow-800 px-1">album</span></div>}
                              {r.defaultImage && <div><span className="rounded bg-yellow-800 px-1">default</span></div>}
                            </td>
                            <td className="truncate p-1.5">{r.game?.name || (r.category ? <span className="text-yellow-300">? {r.category}</span> : "")}</td>
                            <td className="p-1.5">
                              <div className="flex flex-wrap gap-1">
                                {r.defaulted.length > 0 && <span className="rounded bg-orange-600 px-1 font-semibold" title={r.defaulted.map(d => `${d.key}=${JSON.stringify(d.value)}`).join(", ")}>defaulted {r.defaulted.length}</span>}
                                {r.removed.length > 0 && <span className="rounded bg-neutral-600 px-1" title={r.removed.map(x => `${x.reason}: ${x.text}`).join("\n")}>removed {r.removed.length}</span>}
                                {r.aiUsed && <span className="rounded bg-purple-800 px-1">AI</span>}
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b border-neutral-800 bg-neutral-950/60">
                              <td colSpan={7} className="p-3">
                                <Details row={r} onEdit={patch => edit(r.key, patch)} locked={!!r.result || ["dead", "duplicate", "blocked", "error"].includes(r.status)} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function Details({ row, onEdit, locked }: { row: ResultRow; onEdit: (p: Partial<ResultRow>) => void; locked: boolean }) {
  const field = "w-full rounded bg-neutral-200 px-2 py-1 text-xs text-neutral-900 disabled:opacity-70"
  const tag = descriptionTag(row.seller, row.link)
  return (
    <div className="grid gap-4 text-xs lg:grid-cols-2">
      <div className="space-y-2">
        <a href={row.link} target="_blank" rel="noreferrer" className="text-neutral-400 underline">{row.link}</a>
        {row.original.title && (
          <div className="rounded bg-neutral-800 p-2">
            <p className="mb-1 text-neutral-400">Title cleaning (original → listed)</p>
            <p>{diffWords(row.original.title, row.title).map((p, i) => (
              <span key={i} className={p.kind === "removed" ? "text-red-400 line-through" : p.kind === "added" ? "text-green-300" : ""}>{p.text} </span>
            ))}</p>
          </div>
        )}
        <label className="block"><span className="text-neutral-400">Title that will be listed</span>
          <input className={field} value={row.title} disabled={locked} onChange={e => onEdit({ title: e.target.value })} />
        </label>
        <label className="block"><span className="text-neutral-400">Description that will be listed (the tag {tag} is added at the end)</span>
          <textarea className={field} rows={7} value={row.description} disabled={locked} placeholder={`Empty = just ${tag}`} onChange={e => onEdit({ description: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="text-neutral-400">Price (number or x2)</span>
            <input className={field} value={row.priceInput} disabled={locked} onChange={e => onEdit({ priceInput: e.target.value })} />
          </label>
          <div><span className="text-neutral-400">FunPay price (USD, what a buyer pays)</span><div className="py-1">{row.priceText || "not found"}</div></div>
        </div>
        <label className="block"><span className="text-neutral-400">Image links (one per line; imgur is not accepted)</span>
          <textarea className={`${field} font-mono`} rows={3} value={row.images.join("\n")} disabled={locked} onChange={e => onEdit({ images: e.target.value.split(/\s+/).map(s => s.trim()).filter(Boolean), defaultImage: false })} />
        </label>
        {row.images.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {row.images.slice(0, 10).map(u => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="h-16 w-24 rounded object-cover" /></a>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-3">
        {row.flags.length > 0 && (
          <div><p className="font-semibold">Checks</p>
            <ul className="space-y-0.5">
              {row.flags.map((f, i) => <li key={i} className={f.level === "error" ? "text-red-300" : f.level === "warn" ? "text-yellow-300" : "text-neutral-400"}>{f.level === "error" ? "⛔" : f.level === "warn" ? "⚠" : "ℹ"} {f.message}</li>)}
            </ul>
          </div>
        )}
        {Object.keys(row.accountData).length > 0 && (
          <div><p className="font-semibold">Game details sent to GameBoost</p>
            <ul>
              {Object.entries(row.accountData).map(([k, v]) => {
                const d = row.defaulted.find(x => x.key === k)
                return <li key={k} className={d ? "rounded bg-orange-900/70 px-1 font-semibold text-orange-200" : ""}>{k}: {JSON.stringify(v)} {d && `— DEFAULTED to the lowest value (${d.reason})`}</li>
              })}
            </ul>
          </div>
        )}
        {row.removed.length > 0 && (
          <div><p className="font-semibold">Removed by cleaning</p>
            <ul className="text-neutral-400">{row.removed.map((x, i) => <li key={i}><span className="text-red-400 line-through">{x.text.slice(0, 120)}</span> — {x.reason}</li>)}</ul>
          </div>
        )}
        {row.original.description && (
          <details>
            <summary className="cursor-pointer text-neutral-400">Original description from FunPay</summary>
            <p className="mt-1 whitespace-pre-wrap text-neutral-400">{row.original.description}</p>
          </details>
        )}
      </div>
    </div>
  )
}

function DefaultImageInput({ game, count, disabled, onSave }: { game: NonNullable<ResultRow["game"]>; count: number; disabled: boolean; onSave: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const problem = url.trim() ? defaultImageProblem(url) : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[200px]">{game.name} <span className="text-neutral-400">({count} offer{count === 1 ? "" : "s"})</span></span>
      <Input className={`${inputCls} min-w-[280px] flex-1`} placeholder="https://... image link for this game (not imgur)" value={url} onChange={e => setUrl(e.target.value)} />
      {url.trim() && !problem && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url.trim()} alt="" className="h-9 w-14 rounded object-cover" />
      )}
      <Button size="sm" disabled={disabled || saving || !url.trim() || !!problem}
        onClick={async () => { setErr(null); setSaving(true); try { await onSave(url.trim()); setUrl("") } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) } }}>
        {saving ? "Saving…" : `Use for all ${game.name} offers`}
      </Button>
      {(problem || err) && <span className="text-red-300">{problem || err}</span>}
    </div>
  )
}

function GamePicker({ category, count, disabled, onPick }: { category: string; count: number; disabled: boolean; onPick: (g: GameRef) => void }) {
  const [q, setQ] = useState(category.replace(/\s+accounts?$/i, ""))
  const [games, setGames] = useState<GameRef[]>([])
  const [pick, setPick] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const search = async () => {
    setErr(null)
    try {
      const res = await fetch(`/api/gameboost/games?search=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setGames(data.games || [])
      setPick(data.games?.[0] ? String(data.games[0].id) : "")
      if (!data.games?.length) setErr("No GameBoost game found for that search")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[200px]">{category} <span className="text-neutral-400">({count})</span></span>
      <Input className={`${inputCls} w-48`} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} />
      <Button type="button" size="sm" variant="secondary" onClick={search}>Search</Button>
      {games.length > 0 && (
        <select className="rounded bg-neutral-200 px-2 py-1.5 text-neutral-900" value={pick} onChange={e => setPick(e.target.value)}>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}
      <Button size="sm" disabled={disabled || !pick} onClick={() => { const g = games.find(x => String(x.id) === pick); if (g) onPick(g) }}>Use and re-check</Button>
      {err && <span className="text-red-300">{err}</span>}
    </div>
  )
}

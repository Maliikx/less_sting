"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import NavBar from "../navBar"
import ProgressToast, { ProgressToastStack } from "@/components/progressToast"
import { listingProblems, parseImageUrls } from "@/lib/offerRules"

type Offer = {
  id: number
  external_id?: string | null
  title: string
  description?: string
  status: string
  price: string
  price_display?: string
  image_urls?: string[]
  is_manual_delivery?: boolean
  delivery_time?: { duration: number; unit: string; format?: string } | null
  delivery_instructions?: string | null
  account_order_ids?: number[]
  game?: { id: number; name: string; slug: string } | null
  views?: number
  created_at?: number
  sheet: { row: number; employee: string; link: string; note: string } | null
}

/** Render anything GameBoost sends as text (some fields come back as objects, e.g. money). */
function txt(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v !== "object") return String(v)
  const o = v as Record<string, unknown>
  for (const k of ["format", "label", "name", "value", "slug"]) if (o[k] !== undefined && typeof o[k] !== "object") return String(o[k])
  return JSON.stringify(v)
}

const STATUSES = ["", "listed", "draft", "pending", "processing", "sold", "refunded", "archived"]
const EDITABLE = ["draft", "listed", "pending"]

const statusColor: Record<string, string> = {
  listed: "bg-green-700",
  draft: "bg-neutral-500",
  pending: "bg-yellow-700",
  processing: "bg-blue-700",
  sold: "bg-purple-700",
  refunded: "bg-red-800",
  archived: "bg-neutral-700",
}

export default function ManageOffers() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [offers, setOffers] = useState<Offer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [paging, setPaging] = useState<{ next: string | null; prev: string | null; total: number | null; current: number | null; last: number | null }>({
    next: null, prev: null, total: null, current: null, last: null,
  })
  const [editing, setEditing] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async (pageUrl?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams()
      if (search.trim()) q.set("search", search.trim())
      if (status) q.set("status", status)
      if (pageUrl) q.set("page", pageUrl)
      const res = await fetch(`/api/gameboost/offers?${q}`)
      if (res.status === 401) { window.location.href = "/login"; return }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not load offers")
      setOffers(data.offers || [])
      setPaging({ next: data.next, prev: data.prev, total: data.total, current: data.currentPage, last: data.lastPage })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load offers")
    } finally {
      setLoading(false)
    }
  }, [search, status])

  // Load on first open and whenever the status filter changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [status])

  const replaceOffer = (o: Offer) =>
    setOffers(prev => prev.map(x => (x.id === o.id ? { ...x, ...o, sheet: x.sheet } : x)))

  const setVisibility = async (o: Offer, action: "list" | "unlist") => {
    setBusyId(o.id); setError(null); setNotice(null)
    try {
      const res = await fetch(`/api/gameboost/offers/${o.id}/visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      replaceOffer(data.offer)
      setNotice(`#${o.id} is now ${data.offer.status}`)
    } catch (e) {
      setError(`#${o.id}: ${e instanceof Error ? e.message : "failed"}`)
    } finally {
      setBusyId(null)
    }
  }

  const askDelete = (o: Offer) => {
    if (confirmDelete !== o.id) {
      setConfirmDelete(o.id)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmDelete(null), 5000)
      return
    }
    doDelete(o)
  }

  const doDelete = async (o: Offer) => {
    setConfirmDelete(null)
    setBusyId(o.id); setError(null); setNotice(null)
    try {
      const res = await fetch(`/api/gameboost/offers/${o.id}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setOffers(prev => prev.filter(x => x.id !== o.id))
      setNotice(`#${o.id} deleted permanently${data.sheetWarning ? ` (${data.sheetWarning})` : ""}`)
    } catch (e) {
      setError(`#${o.id}: ${e instanceof Error ? e.message : "delete failed"}`)
    } finally {
      setBusyId(null)
    }
  }

  /* ---------------- dead link check (source page says "offer not found") ---------------- */
  type LinkResult = { row: number; gbId: number; title: string; link: string; employee: string; status: string; message?: string }
  const [check, setCheck] = useState<{ running: boolean; checked: number; total: number; dead: LinkResult[]; unchecked: LinkResult[]; done: boolean }>({
    running: false, checked: 0, total: 0, dead: [], unchecked: [], done: false,
  })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number; failed: string[] } | null>(null)
  // Which bulk action is waiting for the user's confirmation (nothing runs until they confirm)
  const [pendingAction, setPendingAction] = useState<"delete" | "unlist" | null>(null)
  const stopCheck = useRef(false)

  const [checkStats, setCheckStats] = useState<string | null>(null)

  const runLinkCheck = async () => {
    stopCheck.current = false
    setError(null); setNotice(null); setBulk(null); setPendingAction(null); setSelected(new Set()); setCheckStats(null)
    setCheck({ running: true, checked: 0, total: 0, dead: [], unchecked: [], done: false })
    const dead: LinkResult[] = []
    const unchecked: LinkResult[] = []
    try {
      // Step 1: match sheet rows to live GameBoost offers (by id, or by title for older listings)
      setCheckStats("Loading your GameBoost offers and matching them to the sheet...")
      const prep = await fetch("/api/gameboost/check-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      })
      const p = await prep.json()
      if (!prep.ok) throw new Error(p.error || "Could not prepare the link check")
      const items: LinkResult[] = p.items || []
      const st = p.stats || {}
      setCheckStats(
        `${st.liveOffers} live offers on GameBoost · ${st.toCheck} matched to a sheet link` +
        (st.matchedByTitle ? ` (${st.matchedByTitle} older rows linked by title)` : "") +
        (st.ambiguous ? ` · ${st.ambiguous} skipped: same title on several offers` : "") +
        (st.notOnGameBoost ? ` · ${st.notOnGameBoost} sheet rows not live on GameBoost` : "")
      )

      // Step 2: open the links in batches
      setCheck({ running: true, checked: 0, total: items.length, dead: [], unchecked: [], done: false })
      const BATCH = 30
      for (let i = 0; i < items.length && !stopCheck.current; i += BATCH) {
        const res = await fetch("/api/gameboost/check-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check", items: items.slice(i, i + BATCH) }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Link check failed")
        for (const r of data.results as LinkResult[]) {
          if (r.status === "not_found") dead.push(r)
          else if (r.status === "error") unchecked.push(r)
        }
        setCheck({ running: true, checked: Math.min(i + BATCH, items.length), total: items.length, dead: [...dead], unchecked: [...unchecked], done: false })
      }
      // Nothing is pre-selected and nothing is changed: the user decides what to do with the list
    } catch (e) {
      setError(e instanceof Error ? e.message : "Link check failed")
    } finally {
      setCheck(c => ({ ...c, running: false, done: true }))
    }
  }

  /** Only ever called from the confirmation box's "Yes" button. */
  const runBulk = async (action: "delete" | "unlist") => {
    setPendingAction(null)
    const chosen = check.dead.filter(d => selected.has(d.gbId))
    const ids = chosen.map(d => d.gbId)
    const rowOf = new Map(chosen.map(d => [d.gbId, d.row]))
    setBulk({ running: true, done: 0, total: ids.length, failed: [] })
    const failed: string[] = []
    const finished: number[] = []
    for (const [n, id] of ids.entries()) {
      try {
        const res = action === "delete"
          ? await fetch(`/api/gameboost/offers/${id}?row=${rowOf.get(id) ?? ""}`, { method: "DELETE" })
          : await fetch(`/api/gameboost/offers/${id}/visibility`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlist", row: rowOf.get(id) }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) failed.push(`#${id}: ${data.error || res.status}`)
        else finished.push(id)
      } catch {
        failed.push(`#${id}: connection error`)
      }
      setBulk({ running: true, done: n + 1, total: ids.length, failed: [...failed] })
    }
    setBulk({ running: false, done: ids.length, total: ids.length, failed })
    {
      setCheck(c => ({ ...c, dead: c.dead.filter(d => !finished.includes(d.gbId)) }))
      setOffers(prev => prev.filter(o => !finished.includes(o.id)))
    }
    setSelected(new Set())
    setNotice(`${action === "delete" ? "Deleted" : "Unlisted"} ${finished.length} of ${ids.length} offer(s)${failed.length ? ` - ${failed.length} failed` : ""}`)
  }

  const syncSheet = async () => {
    setSyncing(true); setError(null); setNotice(null)
    try {
      const res = await fetch("/api/gameboost/sync", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNotice(`Sheet refreshed: ${data.checked} tracked offer(s), ${data.updated} updated, ${data.missing} marked deleted`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="flex w-full max-w-300 px-[5%] md:px-[10%] py-20">
      <Card className="bg-neutral-700/70 border-0 w-full">
        <CardHeader className="border-b-neutral-400 border-b">
          <NavBar active="manage" />
          <CardTitle className="text-white">Manage GameBoost offers</CardTitle>
          <CardDescription>Live from your GameBoost account. Edit, list/unlist or delete. Changes are mirrored to the sheet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col md:flex-row gap-2">
            <Input
              className="border-neutral-600 bg-neutral-200 text-neutral-900"
              placeholder="Search by id, title or description"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === "Enter" && load()}
            />
            <select
              className="rounded-md border border-neutral-600 bg-neutral-200 text-neutral-900 px-2 h-9 text-sm"
              value={status}
              onChange={e => setStatus(e.target.value)}
              aria-label="Status filter"
            >
              {STATUSES.map(s => <option key={s} value={s}>{s || "All statuses"}</option>)}
            </select>
            <Button type="button" variant="secondary" onClick={() => load()} disabled={loading}>
              {loading ? "Loading..." : "Search"}
            </Button>
            <Button type="button" variant="secondary" onClick={syncSheet} disabled={syncing} title="Update GB_STATUS / price / title in the sheet from GameBoost">
              {syncing ? "Refreshing..." : "Refresh sheet from GameBoost"}
            </Button>
          </div>

          {/* Dead link check */}
          <div className="border border-orange-700/60 bg-orange-950/20 rounded-lg p-3 space-y-3 text-white">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" onClick={runLinkCheck} disabled={check.running || !!bulk?.running}>
                {check.running ? (check.total ? `Checking links... ${check.checked}/${check.total}` : "Preparing...") : "Check offer links for \"offer not found\""}
              </Button>
              {check.running && (
                <Button type="button" size="sm" variant="ghost" className="text-neutral-300" onClick={() => { stopCheck.current = true }}>Stop</Button>
              )}
              <span className="text-xs text-neutral-400">Only checks and lists - nothing is changed until you select offers and confirm.</span>
            </div>

            {checkStats && <p className="text-xs text-neutral-300">{checkStats}</p>}
            {(check.running || bulk?.running) && (
              <ProgressToastStack>
                {check.running && (
                  <ProgressToast
                    label="Checking offer links"
                    done={check.checked}
                    total={check.total}
                    color="bg-orange-500"
                    detail={`${check.dead.length} not found${check.unchecked.length ? ` · ${check.unchecked.length} couldn't be opened` : ""}`}
                    onStop={() => { stopCheck.current = true }}
                  />
                )}
                {bulk?.running && <ProgressToast label="Working on selected offers" done={bulk.done} total={bulk.total} color="bg-sky-500" />}
              </ProgressToastStack>
            )}
            {(check.running || check.done) && (
              <p className="text-sm">
                {check.checked}/{check.total} checked · <b className="text-red-400">{check.dead.length} not found</b>
                {check.unchecked.length > 0 && <span className="text-yellow-300"> · {check.unchecked.length} couldn&apos;t be opened (not counted)</span>}
              </p>
            )}

            {check.dead.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="size-4"
                      checked={selected.size > 0 && selected.size === check.dead.length}
                      onChange={e => { setPendingAction(null); setSelected(e.target.checked ? new Set(check.dead.map(d => d.gbId)) : new Set()) }} />
                    Select all ({selected.size}/{check.dead.length})
                  </label>
                  <Button type="button" size="sm" variant="destructive" disabled={!selected.size || !!bulk?.running || check.running} onClick={() => setPendingAction("delete")}>
                    Delete selected ({selected.size})...
                  </Button>
                  <Button type="button" size="sm" variant="secondary" disabled={!selected.size || !!bulk?.running || check.running} onClick={() => setPendingAction("unlist")}>
                    Unlist selected ({selected.size})...
                  </Button>
                  {bulk && <span className="text-xs text-neutral-300">{bulk.running ? `Working ${bulk.done}/${bulk.total}...` : `Done ${bulk.done}/${bulk.total}`}</span>}
                </div>
                {pendingAction && (
                  <div role="alertdialog" className={`rounded-lg border p-3 space-y-2 ${pendingAction === "delete" ? "border-red-600 bg-red-950/50" : "border-sky-600 bg-sky-950/40"}`}>
                    <p className="font-semibold">
                      {pendingAction === "delete"
                        ? `Permanently delete ${selected.size} offer(s) from GameBoost?`
                        : `Unlist (hide) ${selected.size} offer(s) on GameBoost?`}
                    </p>
                    <p className="text-xs text-neutral-300">
                      {pendingAction === "delete"
                        ? "This cannot be undone. Their sheet rows stay and are marked \"deleted\". Offers with orders or that are sold are skipped automatically."
                        : "They move to draft and can be listed again later. Their sheet rows are marked \"draft\"."}
                    </p>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant={pendingAction === "delete" ? "destructive" : "secondary"} onClick={() => runBulk(pendingAction)}>
                        {pendingAction === "delete" ? `Yes, delete ${selected.size}` : `Yes, unlist ${selected.size}`}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="text-neutral-200" onClick={() => setPendingAction(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {bulk && bulk.failed.length > 0 && (
                  <p className="text-xs text-red-300 whitespace-pre-wrap">{bulk.failed.join("\n")}</p>
                )}
                <ul className="max-h-80 overflow-auto divide-y divide-neutral-700 text-sm">
                  {check.dead.map(d => (
                    <li key={d.gbId} className="flex items-start gap-2 py-1.5">
                      <input type="checkbox" className="size-4 mt-0.5" checked={selected.has(d.gbId)}
                        onChange={e => setSelected(prev => { setPendingAction(null); const n = new Set(prev); if (e.target.checked) n.add(d.gbId); else n.delete(d.gbId); return n })} />
                      <div className="min-w-0">
                        <p className="break-words">{d.title} <span className="text-neutral-500">#{d.gbId} · row {d.row} · {d.employee}</span></p>
                        <a href={d.link} target="_blank" rel="noreferrer" className="text-xs text-neutral-400 underline break-all">{d.link}</a>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {check.done && !check.running && check.dead.length === 0 && check.total > 0 && (
              <p className="text-sm text-green-400">No dead links found.</p>
            )}
            {check.unchecked.length > 0 && !check.running && (
              <details className="text-xs text-neutral-400">
                <summary className="cursor-pointer">Links that couldn&apos;t be opened ({check.unchecked.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {check.unchecked.map(u => <li key={u.gbId}>#{u.gbId} {u.title} - {u.message}</li>)}
                </ul>
              </details>
            )}
          </div>

          {error && <p className="text-red-400 bg-red-950/30 p-2 rounded text-sm whitespace-pre-wrap">{error}</p>}
          {notice && <p className="text-green-400 bg-green-950/30 p-2 rounded text-sm">{notice}</p>}

          {!loading && offers.length === 0 && !error && (
            <p className="text-neutral-400 text-sm">No offers found.</p>
          )}

          <ul className="space-y-3">
            {offers.map(o => {
              const status = txt(o.status)
              const editable = EDITABLE.includes(status)
              const hasOrders = !!o.account_order_ids?.length
              const busy = busyId === o.id
              return (
                <li key={o.id} className="border border-neutral-600 bg-neutral-900 rounded-lg p-3 text-white">
                  <div className="flex gap-3">
                    {o.image_urls?.[0] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.image_urls[0]} alt="" className="w-20 h-20 object-cover rounded hidden sm:block" />
                    )}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${statusColor[status] || "bg-neutral-600"}`}>{status}</span>
                        <span className="text-xs text-neutral-400">#{o.id}</span>
                        {o.game?.name && <span className="text-xs text-neutral-400">{txt(o.game.name)}</span>}
                        {o.is_manual_delivery && (
                          <span className="text-xs text-sky-300">manual{o.delivery_time?.format ? ` · ${txt(o.delivery_time.format)}` : ""}</span>
                        )}
                        {hasOrders && <span className="text-xs text-purple-300">orders: {o.account_order_ids!.join(", ")}</span>}
                      </div>
                      <p className="font-medium break-words">{txt(o.title)}</p>
                      <p className="text-sm">
                        <b>{txt(o.price_display) || `€${txt(o.price)}`}</b>
                        {o.views !== undefined && o.views !== null && <span className="text-neutral-400"> · {txt(o.views)} views</span>}
                        {o.sheet ? (
                          <span className="text-neutral-400">
                            {" "}· sheet row {o.sheet.row} · {o.sheet.employee}
                            {o.sheet.link && (
                              <> · <a className="underline" href={o.sheet.link} target="_blank" rel="noreferrer">source</a></>
                            )}
                          </span>
                        ) : (
                          <span className="text-neutral-500"> · not in sheet</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button size="sm" variant="secondary" disabled={!editable || busy} onClick={() => setEditing(editing === o.id ? null : o.id)}>
                      {editing === o.id ? "Close edit" : "Edit"}
                    </Button>
                    {status === "listed" && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setVisibility(o, "unlist")}>Unlist (hide)</Button>
                    )}
                    {status === "draft" && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setVisibility(o, "list")}>List (publish)</Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!editable || hasOrders || busy}
                      onClick={() => askDelete(o)}
                      title={!editable || hasOrders ? "Only draft/listed offers without orders can be deleted" : "Permanent"}
                    >
                      {confirmDelete === o.id ? "Click again to DELETE permanently" : "Delete"}
                    </Button>
                    {busy && <span className="text-xs text-neutral-400 self-center">Working...</span>}
                  </div>

                  {editing === o.id && (
                    <EditOffer
                      offer={o}
                      onSaved={(updated, warn) => {
                        replaceOffer(updated)
                        setEditing(null)
                        setNotice(`#${o.id} saved${warn ? ` (${warn})` : ""}`)
                      }}
                    />
                  )}
                </li>
              )
            })}
          </ul>

          {(paging.prev || paging.next) && (
            <div className="flex items-center justify-between text-sm text-neutral-300">
              <Button size="sm" variant="secondary" disabled={!paging.prev || loading} onClick={() => load(paging.prev)}>← Prev</Button>
              <span>
                {paging.current && paging.last ? `Page ${paging.current} of ${paging.last}` : ""}
                {paging.total !== null ? ` · ${paging.total} offers` : ""}
              </span>
              <Button size="sm" variant="secondary" disabled={!paging.next || loading} onClick={() => load(paging.next)}>Next →</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function EditOffer({ offer, onSaved }: { offer: Offer; onSaved: (o: Offer, warning?: string) => void }) {
  const initial = {
    title: txt(offer.title),
    price: txt(offer.price),
    description: txt(offer.description),
    images: (offer.image_urls || []).join("\n"),
    duration: txt(offer.delivery_time?.duration),
    unit: txt(offer.delivery_time?.unit) || "hours",
    instructions: txt(offer.delivery_instructions),
  }
  const [v, setV] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV(prev => ({ ...prev, [k]: e.target.value }))

  const save = async () => {
    // Only send what changed - GameBoost allows max 10 writes per offer per hour
    const changes: Record<string, unknown> = {}
    if (v.title !== initial.title) changes.title = v.title
    if (v.price !== initial.price) changes.price = v.price
    if (v.description !== initial.description) changes.description = v.description
    if (v.images !== initial.images) changes.image_urls = parseImageUrls(v.images)
    if (v.duration !== initial.duration || v.unit !== initial.unit) changes.delivery_time = { duration: Number(v.duration), unit: v.unit }
    if (v.instructions !== initial.instructions) changes.delivery_instructions = v.instructions

    if (!Object.keys(changes).length) { setErr("Nothing changed"); return }
    const problems = listingProblems({
      title: changes.title as string | undefined,
      description: changes.description as string | undefined,
      imageUrls: changes.image_urls as string[] | undefined,
    })
    if (problems.length) { setErr(problems.join("; ")); return }

    setSaving(true); setErr(null)
    try {
      const res = await fetch(`/api/gameboost/offers/${offer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSaved(data.offer, data.sheetWarning)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const label = "text-xs text-neutral-300 block mb-1"
  return (
    <div className="mt-3 border-t border-neutral-700 pt-3 space-y-3">
      <div>
        <label className={label}>Title</label>
        <Input className="border-neutral-600" value={v.title} onChange={set("title")} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={label}>Price (EUR)</label>
          <Input className="border-neutral-600" inputMode="decimal" value={v.price} onChange={set("price")} />
        </div>
        <div>
          <label className={label}>Delivery time</label>
          <Input className="border-neutral-600" inputMode="numeric" value={v.duration} onChange={set("duration")} />
        </div>
        <div>
          <label className={label}>Unit</label>
          <select className="w-full rounded-md border border-neutral-600 bg-transparent h-9 px-2 text-sm" value={v.unit} onChange={set("unit")}>
            {["minutes", "hours", "days"].map(u => <option key={u} value={u} className="text-black">{u}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={label}>Description</label>
        <Textarea className="border-neutral-600 min-h-[80px]" value={v.description} onChange={set("description")} />
      </div>
      <div>
        <label className={label}>Image URLs (one per line - the full list replaces the current images)</label>
        <Textarea className="border-neutral-600 font-mono text-xs" value={v.images} onChange={set("images")} />
      </div>
      <div>
        <label className={label}>Delivery instructions (visible to buyer, not encrypted)</label>
        <Textarea className="border-neutral-600" value={v.instructions} onChange={set("instructions")} />
      </div>
      {err && <p className="text-red-400 text-sm">{err}</p>}
      <Button type="button" className="bg-white text-black hover:bg-neutral-200" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save changes to GameBoost"}
      </Button>
    </div>
  )
}

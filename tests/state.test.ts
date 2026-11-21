import test from "node:test"
import assert from "node:assert/strict"
import { MemoryStateStore, type StateStore } from "../lib/state/store"
import { SheetStateStore, StateTabConflictError, STATE_HEADERS } from "../lib/state/sheetStore"
import { AiClient, type FetchLike, type ProviderEntry } from "../lib/ai/provider"
import { fakeSpreadsheet } from "./helpers/fakeSheet"

/* ------------------------------------------------------------ both stores, same contract */

function contract(name: string, make: (now: () => number) => StateStore) {
  test(`${name}: set/get/getMany, overwrite, TTL`, async () => {
    let t = 1_000
    const s = make(() => t)
    assert.equal(await s.get("nope"), null)
    await s.set("a", { n: 1 })
    await s.set("b", [1, 2], { ttlMs: 500 })
    assert.deepEqual((await s.get("a"))!.value, { n: 1 })
    await s.set("a", { n: 2 })
    assert.deepEqual((await s.get("a"))!.value, { n: 2 })
    const many = await s.getMany(["a", "b", "c"])
    assert.deepEqual([...many.keys()].sort(), ["a", "b"])
    t += 600
    assert.equal(await s.get("b"), null, "expired")
    await s.setMany<unknown>([{ key: "c", value: "x" }, { key: "a", value: 3 }])
    assert.equal((await s.get("c"))!.value, "x")
    assert.equal((await s.get("a"))!.value, 3)
  })
}
contract("memory store", now => new MemoryStateStore(now))
contract("sheet store", now => new SheetStateStore(fakeSpreadsheet().api, "LS_STATE", now))

/* ------------------------------------------------------------ sheet store safety */

test("sheet store: creates its own tab with headers; never reads or writes any other tab", async () => {
  const f = fakeSpreadsheet({ Sheet1: [["LINK"], ["keep me"]], Other: [["x"]] })
  const s = new SheetStateStore(f.api, "LS_STATE")
  await s.set("k", 1)
  await s.set("k", 2)
  await s.get("k")
  assert.deepEqual(f.tabs.LS_STATE[0], STATE_HEADERS)
  assert.equal(f.tabs.LS_STATE.length, 2, "overwrites the key's row instead of appending")
  assert.deepEqual(f.tabs.Sheet1, [["LINK"], ["keep me"]])
  assert.deepEqual(f.tabs.Other, [["x"]])
  for (const r of f.touched) assert.ok(r === "add:LS_STATE" || r.startsWith("'LS_STATE'!"), `touched ${r}`)
})

test("sheet store: refuses a same-named tab that is not ours, and leaves it untouched", async () => {
  const f = fakeSpreadsheet({ Sheet1: [["LINK"]], LS_STATE: [["Name", "Phone"], ["Ali", "123"]] })
  const s = new SheetStateStore(f.api, "LS_STATE")
  await assert.rejects(s.set("k", 1), StateTabConflictError)
  await assert.rejects(s.get("k"), StateTabConflictError)
  assert.deepEqual(f.tabs.LS_STATE, [["Name", "Phone"], ["Ali", "123"]])
  const notes = fakeSpreadsheet({ LS_STATE: [[], [], ["some note"]] })
  await assert.rejects(new SheetStateStore(notes.api).set("k", 1), StateTabConflictError, "empty header but data below: not ours")
})

test("sheet store: an existing tab of ours is reused; an empty tab with our name is claimed", async () => {
  const ours = fakeSpreadsheet({ LS_STATE: [STATE_HEADERS, ["k", "5", "1", ""]] })
  assert.equal((await new SheetStateStore(ours.api).get("k"))!.value, 5)
  const empty = fakeSpreadsheet({ LS_STATE: [] })
  await new SheetStateStore(empty.api).set("k", 1)
  assert.deepEqual(empty.tabs.LS_STATE[0], STATE_HEADERS)
})

test("sheet store: duplicate rows for a key (two instances appended at once) -> newest wins; bad JSON ignored", async () => {
  const f = fakeSpreadsheet({ LS_STATE: [STATE_HEADERS, ["k", "1", "100", ""], ["k", "2", "200", ""], ["bad", "{oops", "1", ""]] })
  const s = new SheetStateStore(f.api)
  assert.equal((await s.get("k"))!.value, 2)
  assert.equal(await s.get("bad"), null)
  await s.set("k", 3)
  assert.equal(f.tabs.LS_STATE[2][1], "3", "the newest row is the one updated")
})

test("sheet store: one write call for several keys", async () => {
  const f = fakeSpreadsheet()
  const s = new SheetStateStore(f.api)
  await s.set("a", 1)
  const before = f.ops()
  await s.setMany([{ key: "a", value: 2 }, { key: "b", value: 3 }, { key: "c", value: 4 }])
  assert.equal(f.ops() - before, 3, "1 read + 1 batch update + 1 append")
})

/* ------------------------------------------------------------ AI client: two instances share state */

const CHAIN: ProviderEntry[] = [
  { provider: "groq", model: "big", baseUrl: "http://groq", apiKey: "k" },
  { provider: "gemini", model: "flash", baseUrl: "http://gemini", apiKey: "k" },
]
function aiFetch(seen: string[], status: (url: string) => number): FetchLike {
  return async url => {
    seen.push(url)
    const st = status(url)
    return {
      ok: st < 400,
      status: st,
      headers: { get: (h: string) => (h === "retry-after" && st === 429 ? "120" : null) },
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 300 } }),
    }
  }
}

for (const [name, mk] of [
  ["memory", () => new MemoryStateStore()],
  ["sheet", () => new SheetStateStore(fakeSpreadsheet().api)],
] as const) {
  test(`AI state (${name} store): a cooldown hit by instance A is respected by instance B`, async () => {
    const store = mk()
    const t = 5_000_000
    const seenA: string[] = []
    const a = new AiClient(CHAIN, { store, now: () => t, fetch: aiFetch(seenA, u => (u.startsWith("http://groq") ? 429 : 200)) })
    const r = await a.chatJson("s", "u")
    assert.equal(r.used, "gemini:flash")

    const seenB: string[] = []
    const b = new AiClient(CHAIN, { store, now: () => t + 1000, fetch: aiFetch(seenB, () => 200) }) // a fresh serverless instance
    const r2 = await b.chatJson("s", "u")
    assert.equal(r2.used, "gemini:flash", "B skips groq: it is still cooling down (shared)")
    assert.ok(!seenB.some(u => u.startsWith("http://groq")))

    const c = new AiClient(CHAIN, { store, now: () => t + 121_000, fetch: aiFetch([], () => 200) })
    assert.equal((await c.chatJson("s", "u")).used, "groq:big", "after Retry-After (120 s) groq is used again")
  })

  test(`AI state (${name} store): daily token counter is shared and the budget applies across instances`, async () => {
    const store = mk()
    const t = Date.UTC(2026, 10, 18, 10)
    const a = new AiClient(CHAIN.slice(0, 1), { store, now: () => t, dailyTokenBudget: 500, fetch: aiFetch([], () => 200) })
    await a.chatJson("s", "u")
    const b = new AiClient(CHAIN.slice(0, 1), { store, now: () => t, dailyTokenBudget: 500, fetch: aiFetch([], () => 200) })
    await b.chatJson("s", "u")
    assert.equal((await b.sharedUsage())[0].tokensToday, 600)
    const c = new AiClient(CHAIN.slice(0, 1), { store, now: () => t, dailyTokenBudget: 500, fetch: aiFetch([], () => 200) })
    await assert.rejects(c.chatJson("s", "u"), /daily token budget used/)
    const nextDay = new AiClient(CHAIN.slice(0, 1), { store, now: () => t + 86_400_000, dailyTokenBudget: 500, fetch: aiFetch([], () => 200) })
    await nextDay.chatJson("s", "u")
    assert.equal(nextDay.usage()[0].tokensToday, 300, "counter starts again the next day")
  })
}

test("AI state: a broken store never stops the AI call", async () => {
  const broken: StateStore = {
    get: async () => { throw new Error("sheets down") },
    getMany: async () => { throw new Error("sheets down") },
    set: async () => { throw new Error("sheets down") },
    setMany: async () => { throw new Error("sheets down") },
  }
  const warn = console.warn
  const warned: unknown[] = []
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    const r = await new AiClient(CHAIN, { store: broken, fetch: aiFetch([], () => 200) }).chatJson("s", "u")
    assert.equal(r.used, "groq:big")
    assert.equal(warned.length, 1, "warned once, not per call")
  } finally {
    console.warn = warn
  }
})

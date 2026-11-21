import test from "node:test"
import assert from "node:assert/strict"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ProgressToast, { ProgressToastStack } from "../components/progressToast"

test("progress toast: floating (fixed, on top), label, counts, percent, optional Stop", () => {
  const html = renderToStaticMarkup(h(ProgressToastStack, null, h(ProgressToast, { label: "Publishing", done: 3, total: 12, onStop: () => {} })))
  assert.match(html, /class="[^"]*\bfixed\b[^"]*\bz-50\b/, "fixed and on top, so it is visible anywhere on the page")
  assert.match(html, /role="status"/)
  assert.match(html, /Publishing/)
  assert.match(html, /3 \/ 12/)
  assert.match(html, /25%/)
  assert.match(html, />Stop</)
  const starting = renderToStaticMarkup(h(ProgressToast, { label: "Reading", done: 0, total: 0 }))
  assert.match(starting, /starting…/)
  assert.doesNotMatch(starting, />Stop</)
})

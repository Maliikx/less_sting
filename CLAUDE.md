# Less Sting: context for Claude Code

Internal Next.js 16 (App Router, React 19, TypeScript, Tailwind, react-hook-form + zod) tool. Employees list game accounts
(~100/day, target ~300/day) on the GameBoost marketplace, all manual delivery. Every listing is logged to a Google Sheet.

## Deployment (online-first, no host machine)
- Runs on **Vercel Pro** (Hobby is non-commercial only) from a private GitHub repo. Every PR gets a Vercel preview deployment; test there.
- Secrets live in Vercel environment variables (and `.env.local` for local dev only). Never commit `.env.local`.
- **Serverless: module-level memory is NOT reliable.** Each request may hit a fresh instance; nothing in a `Map`, a class field or a
  module variable survives between requests or is shared between instances. Anything that must persist (AI cooldowns, daily token
  counters, lot-id cache, dead-check results, cron cursor) goes through a persistent store (`StateStore`, plan step 3).
  Today `AiClient` (`lib/ai/provider.ts`) still keeps cooldowns/token counts in memory: treat them as per-instance best effort until step 3.
- Function time limits apply: long jobs (probe, dead-check scan) run in small chunks driven by the browser or by cron with a cursor.

## Sheet layout (first tab, row 1 headers)
A LINK, B PRICE (number or xN), C EMPLOYEE, D TITLE (duplicate check), E NOTE, F CREATED_AT (Cairo time),
G GB_OFFER_ID, H GB_STATUS, I EXTERNAL_ID, J GB_PRICE_EUR, K GAME, L GB_UPDATED_AT. Rows are never deleted; deleted offers get `deleted` in H.
2000+ old rows have no GB id (match them by title).

## Goal being built
Employee gives: FunPay single-offer link + price (number or multiplier) + seller code. The app reads the page, translates Russian to English,
removes banned words (instant/auto delivery, guarantee, warranty, personal account, FunPay/other site names, refund, seller advertising,
contacts), collects images and game fields, checks duplicates and dead ("offer not found") offers, and lists on GameBoost. Dead/duplicate
offers are offered for bulk deletion after confirmation. Reliability over speed: anything uncertain is flagged for a human, never guessed.

## Decisions already made (do not re-open without asking)
- AI: free hosted models through an OpenAI-compatible chain (Groq first, Gemini fallback, optional local Ollama). Set by `AI_PROVIDERS`. No paid Anthropic API.
- Rules first, AI last (cost): duplicate by lot id -> fetch (dead/blocked stop here) -> regex cleaning -> FunPay params -> ONE AI call only if Russian or fields missing -> re-clean + violation check.
- AI field values need a quote that exists in the source; enum/number checked in code.
- Required game fields not found: fill the LOWEST value (integer = min, list = first option, boolean = false) and report it (`defaulted`);
  such offers are LISTED IMMEDIATELY, but highlighted in the UI and logged to the sheet.
- Price: read as-is from the page, no currency conversion; multiplier (`x2`, `1.75x`, `*2`) = source price x factor.
- "Blocked" or timed-out source pages are never treated as dead. Dead = two `not_found` results at least 24 h apart; stop the scan if an abnormal share is not_found.
- Capacity target ~300 listings/day: keep tokens low (cascade, trim, cache), keep the provider chain.
- Source adapters in `lib/sources`, destination adapters (GameBoost only for now).
- **Eldorado is PARKED** (later: a second destination, not a source). Do not write Eldorado code.
- If FunPay blocks the server: never loop faster or rotate addresses. Plan A slower + backoff + cache; Plan B capture HTML in the employee's
  browser and send it to the app; Plan C paid fetching service (ask before spending money).

## What exists (slice 1, prepare-only; nothing new publishes or writes the sheet)
lib/sources (FunPay adapter), lib/cleaning, lib/ai (provider chain + extract), lib/gameFields.ts, lib/gameProfile.ts, lib/probeRequired.ts,
lib/pipeline/prepare.ts, app/api/ai/prepare/route.ts, scripts/probe-funpay.ts, tests/ (offline tests: `npm test`).
Existing app (do not break): `/` offers form, `/manage` (dead-link check), `POST /api/offers` (creates on GameBoost, 422 retry, sheet logging,
duplicate-title check), signed session cookie, `proxy.ts` auth for all `/api` routes except `/api/login` and `/api/gameboost/sync`.

## FunPay facts (checked against real pages, plan steps 1-2; samples in tests/fixtures/real)
- FunPay does NOT block Vercel: preview probe of 22 links = 16 ok / 6 not_found / 0 blocked.
- `/en/` pages show FunPay's own English translation of Russian offers, so the AI translation step is rarely needed.
- Category + id come from the page's back link (`/lots/<id>/`, e.g. 346 = PUBG Mobile Accounts); game = category minus "Accounts".
- Images: full-size = the `href` of `a.attachments-thumb` (the background-image is a thumbnail). About 1 in 3 offers has no gallery and
  links an album/video in the description instead (postimg, imgur, YouTube): listed in `externalMedia`.
  DECIDED: flag these AND try the album (`lib/sources/media.ts`, max 2 albums per offer). postimg images are used (flag `album_images`
  for review); imgur images are found but GameBoost refuses imgur, so they are not used: "add images by hand" (user decision, no re-hosting). Album markup is UNVERIFIED (check via /probe).
  GameBoost needs at least one image: no images = needs review, never listed.
- Price: the buy form lists payment options per currency (`data-cy`); which currencies appear depends on the visitor.
  DECIDED: price = what a buyer pays in USD (cheapest USD option). No USD on the page = no price + warning, never another currency.
  `data-factors[0]` is the seller's own price (~7% lower), kept as `sellerPrice` for information only.
  The `/` form's link preview uses the same USD price for FunPay links (user OK'd this change to `/`; images there unchanged).
- Dead offer = HTTP 404 with heading "Offer not found". Only the status/heading counts, never the description text.
  KNOWN ISSUE: `/manage` dead-link check (`checkSource`) still matches "offer not found" anywhere in the page text (not fixed: `/manage` rule).
- `npm run probe:funpay` works again; `npx tsx scripts/parser-report.ts [dir]` measures the parser on saved pages offline.

## Batch listing UI (plan step 4, decided with the user)
- Employees list 10-20 offers at a time. Input is ONE paste box, one line per offer: `link price seller` (price = number or multiplier).
  Those three are the only manual fields.
- One compact table to review (status, cleaned title, price, images, game; badges for defaulted fields / removed text), details expand
  on click, "Publish selected" for all ready rows. Lightweight, not a form per offer. The existing `/` form stays as it is.

## NOT verified yet
1. Behaviour of FunPay over time / at volume (300/day) from Vercel.
2. AI path only tested against a mock; Groq/Gemini model names and free limits change.
3. Whether the GameBoost required-field probe finds required fields for real games.
4. Whether GameBoost PATCH replaces or merges `image_urls`.

## Rules for every change
- Run `npm test` before every commit; keep new logic pure and injectable so it is testable offline. Add tests with each change.
- Never delete GameBoost offers, unlist, or edit sheet rows without an explicit confirmation step in the UI. Never delete sheet rows.
- Never commit secrets; never log API keys, full credentials or full page contents; protect every new `/api` route with the session check.
- Limits: GameBoost writes 500/min and 10/hour per offer; Google Sheets writes batched; FunPay at most ~1 request per 1.5 s.
- Do not change existing behaviour of `/`, `/manage` and `POST /api/offers` unless the step says so.
- If something is unclear or a result is worse than the acceptance criteria, stop and report. Do not paper over it.
- One branch and one PR per plan step.

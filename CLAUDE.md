# Less Sting: context for Claude Code

Internal Next.js 16 (App Router, React 19, TypeScript, Tailwind, react-hook-form + zod) tool. Employees list game accounts
(~100/day, target ~300/day) on the GameBoost marketplace, all manual delivery. Every listing is logged to a Google Sheet.

## Deployment (online-first, no host machine)
- Runs on **Vercel Pro** (Hobby is non-commercial only) from a private GitHub repo. Every PR gets a Vercel preview deployment; test there.
- Secrets live in Vercel environment variables (and `.env.local` for local dev only). Never commit `.env.local`.
- **Serverless: module-level memory is NOT reliable.** Each request may hit a fresh instance; nothing in a `Map`, a class field or a
  module variable survives between requests or is shared between instances. Anything that must persist (AI cooldowns, daily token
  counters, dead-check results, cron cursor) goes through the persistent `StateStore` (`lib/state`, plan step 3):
  the sheet's own tab `LS_STATE` (env `STATE_SHEET_TAB`; KEY | VALUE json | UPDATED_AT | EXPIRES_AT). The store creates that tab,
  only ever reads/writes inside it, and refuses a same-named tab it did not create. The other tabs (Sheet1, Example, stats, backup)
  are never edited by it (user rule). Last-write-wins, no locks: fine for cooldowns/counters, not for anything that needs a lock.
  `AiClient` syncs cooldowns and daily token counts through it (checked live: two instances share a cooldown).
  The lot-id duplicate cache in /api/ai/prepare stays a 30 s per-instance read cache of the main sheet on purpose (sheet = truth).
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
  for review); imgur images are found but GameBoost refuses imgur, so they are not used: "add images by hand" (user decision, no re-hosting). Checked on the Vercel preview 2026-11-18: postimg gallery -> 10 images used; imgur album -> 2 found, not used.
  GameBoost needs at least one image: no images = needs review, never listed.
- Price: the buy form lists payment options per currency (`data-cy`); which currencies appear depends on the visitor.
  DECIDED: price = what a buyer pays in USD (cheapest USD option). No USD on the page = no price + warning, never another currency.
  `data-factors[0]` is the seller's own price (~7% lower), kept as `sellerPrice` for information only.
  The `/` form's link preview uses the same USD price for FunPay links (user OK'd this change to `/`; images there unchanged).
- Dead offer = HTTP 404 with heading "Offer not found". Only the status/heading counts, never the description text.
  KNOWN ISSUE: `/manage` dead-link check (`checkSource`) still matches "offer not found" anywhere in the page text (not fixed: `/manage` rule).
- `npm run probe:funpay` works again; `npx tsx scripts/parser-report.ts [dir]` measures the parser on saved pages offline.

## Batch listing UI (plan step 4, decided with the user)
- Employees list 10-20 offers at a time, each seller for themselves. `/auto`: the SELLER is chosen ONCE at the top (remembered);
  each row has only offer link + price (number or multiplier). Plus price for all, +10 rows, "paste many links" (`link [price]`).
  Settings next to the publish buttons (remembered per browser): delivery time + unit, default description, delivery instructions,
  "Create as draft" / "List immediately". The page shows 4 steps (offers, prepare = read + clean, review, publish).
- Duplicates are checked by TITLE ONLY (user decision): the page's original title and the cleaned title vs the sheet TITLE
  column, and vs earlier offers in the batch. The page is read first (no AI is spent on duplicates). The same link twice is NOT
  blocked: it is read again and caught by its title. Rows are keyed by their own row id (not the lot id).
- No description at all -> the description is just the seller tag `#<seller>-<last 8 chars of the link>` (same tag POST /api/offers
  appends to every listing, so it appears once). User asked for "last 6 digits": switching the tag everywhere would change `/` too (asked).
- The review table shows each cleaned title and, under it, the original with removed words struck through (`lib/auto/diff.ts`).
- Offers with no images: the user sets a DEFAULT IMAGE per GameBoost game once (link, not imgur), stored in the sheet's own tab
  `DEFAULT_IMG` (GAME_ID | GAME_NAME | IMAGE_URL | UPDATED_AT; env DEFAULT_IMG_TAB; same own-tab guard as LS_STATE, `lib/state/ownTab.ts`).
  Later offers of that game without images use it automatically (warn flag `default_image`, sheet NOTE "default image").
- Speed: page reads START >= 1.5 s apart (shared gate) but up to 3 offers are in flight, so AI calls overlap the next read; 8 offers
  per prepare call; game field specs cached in LS_STATE for 24 h; publish sends 5 per call; existing-offer lookups run in parallel.
- One compact table to review (status, cleaned title, price, images, game; badges for defaulted fields / removed text), details expand
  on click. Buttons act on ticked rows and show counts: Publish (ready rows), List now (drafts), Back to draft (listed), Delete
  (created offers; confirmation; uses the existing DELETE route that refuses sold/ordered offers and marks the sheet row `deleted`).
  Selection rules are pure + tested in `lib/auto/rows.ts`. The existing `/` form stays as it is.
- BUILT (step 4): `/auto` page, `lib/auto/*` (lines parser, prepareBatch = one page at a time 1.5 s apart, game resolution, review
  re-check), `POST /api/auto/publish` -> `lib/destinations` (DestinationAdapter; GameBoost adapter calls the EXISTING
  `POST /api/offers` handler in-process, one request per seller+game). Server re-checks images + banned words before publishing.
- TESTING PHASE: the page defaults to "Create as draft"; the user can switch to "List immediately" (server only lists on a literal
  `listNow: true`). The user does not want `main`/production changed yet: test on PR previews; previews should use a COPY of the sheet (Preview-only
  `GOOGLE_SHEET_ID`) so test publishes don't land in the real Sheet1.
- Game: FunPay category -> GameBoost game by exact unique name, else the user picks once per category; remembered in `LS_STATE`
  (`gamemap:funpay:<categoryId>`). Rental offers ("Offer type: Rent"/"Аренда") are flagged and cannot be published.
- Sheet NOTE for auto rows: `auto · defaulted: <fields> · album images`.
- Credentials (manual delivery message the buyer receives) = an editable template on /auto, default
  "thank you for your purchase\n\ndelivery takes anywhere from 5 min up to [delivery time] ❤️"; `[delivery time]` is filled on the
  server from the delivery setting ("1 hour", "2 days"); max 500 chars (`lib/auto/credentials.ts`).
- Screenshots only on imgur -> its own flag `imgur_images` (red "imgur" badge + notice), NOT `no_images`, and the game's default
  image is NOT used for them (real screenshots exist; the employee adds other image links).
- Publishing 20 offers in one request hit Vercel's time limit (HTTP 504). POST /api/offers writes the sheet only AFTER all creates,
  so a timeout can leave offers on GameBoost with no sheet row. Fix: the page publishes 3 offers per request (maxDuration 300), and
  /api/auto/publish first looks each title up on GameBoost: if it already exists it is NOT created again and its missing sheet row
  is appended (NOTE "recovered after an interrupted publish"). So pressing Publish again after a timeout is safe.

## Cleaning (rules first, then AI)
- Rules (`lib/cleaning`): banned terms cut their clause; a sentence with contacts, links, seller advertising, SELLER POLICY
  (auto-issued data, no returns/refunds, record a video, ask before buying, not responsible...) or a STORE INTRODUCTION
  (hello/welcome/my shop/thank you for choosing...) is dropped whole; FAQ blocks (heading -> blank line) and Q:/A: lines are dropped;
  any sentence naming the FunPay seller (`sellerName`, read from the offer page) is dropped.
- AI runs when the text is not English, when GameBoost fields are still missing, OR when the description still has first-person
  seller talk (I/me/my/we/our). Its prompt lists what to remove and keeps account facts from removed sentences.
- Titles: emoji runs (✅ 🔥) and 【】/[] also separate parts, so "INSTANT DELIVERY" / "【WARRANTY】" are cut as whole parts; banned
  phrases match longest-first; leftover empty/unmatched brackets and repeated emoji are tidied. Descriptions: sentences where the
  shop speaks as "we/our" ("seller talk") and shop marketing ("here you will find", "great prices", "how does the deal work"...)
  are dropped; lines left without letters ("1.") are dropped. Checked on real Fortnite offer 82035328 (almost all marketing).
- GameBoost list fields: a template can describe "x" and "x.*" (item with options); `normalizeSpecs` merges them into ONE array
  field and `shapeAccountData` never sends "x.*" keys and always sends lists as lists (live 422 "linkable_platforms.0 is invalid").
  Cached game specs use key `gameprofile:v2:<id>`.
- FunPay categories can be "Accounts for Fortnite" as well as "PUBG Mobile Accounts" (both -> game name).
- FunPay params -> GameBoost fields without AI (`fieldsFromParams`): labels match by subject words ("Email linking" ~
  email_not_linked), negative field names flip yes/no ("Email linked" -> email_not_linked = No), "Any platform" -> all options of a
  multi-choice field or an any/all/cross option; never a guess when two labels match. Checked on real offer 69446008 (Genshin).

## AI capacity (2026-11-19 estimate; limits change, check the Groq console)
- Groq RETIRED llama-3.3-70b-versatile and llama-3.1-8b-instant on 2026-08-16 (live error 2026-11-21: "model does not exist").
  Use `AI_PROVIDERS=groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b` (Groq's recommended replacements). They are reasoning
  models: the client sends reasoning_effort "low" and max_tokens >= 2500. The limits below were for the llama models.
- One AI call ~1,300 tokens on real offers (range ~870-1,800). AI runs only when text is not English (rare: /en/ pages are translated)
  or GameBoost fields are missing from the FunPay params.
- Groq free (third-party sources, unofficial): llama-3.3-70b ~1,000 req/day, 100k-200k tokens/day, 6k-12k tokens/min;
  llama-3.1-8b ~14,400 req/day, ~500k tokens/day, ~6k tokens/min. Limits are per Groq organization (shared by all employees).
  Gemini 2.5 Flash free tier reportedly cut to ~20 req/day (unconfirmed). => worst case (AI on every offer) ~450 offers/day.

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

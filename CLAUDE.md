# Less Sting: context for Claude Code

Internal Next.js 16 (App Router, React 19, TypeScript, Tailwind, react-hook-form + zod) tool. Employees list game accounts
(~100/day, target ~300/day) on the GameBoost marketplace, all manual delivery. Every listing is logged to a Google Sheet.
Runs locally (`npm run dev`). Settings are in `.env.local` (never commit it).

## Sheet layout (first tab, row 1 headers)
A LINK, B PRICE (number or xN), C EMPLOYEE, D TITLE (duplicate check), E NOTE, F CREATED_AT (Cairo time),
G GB_OFFER_ID, H GB_STATUS, I EXTERNAL_ID, J GB_PRICE_EUR, K GAME, L GB_UPDATED_AT. Rows are never deleted; deleted offers get `deleted` in H.
2000+ old rows have no GB id (match them by title).

## Goal being built
Employee gives: FunPay single-offer link + price (number or multiplier) + seller code. The app reads the page, translates Russian to English,
removes banned words (instant/auto delivery, guarantee, warranty, personal account, FunPay/other site names, refund, seller advertising),
collects images and game fields, checks duplicates and dead ("offer not found") offers, and lists on GameBoost. Dead/duplicate offers are
offered for bulk deletion after confirmation.

## Decisions already made
- AI: free hosted models through an OpenAI-compatible chain (Groq first, Gemini fallback, optional local Ollama). Set by `AI_PROVIDERS`. No paid Anthropic API.
- Rules first, AI last (cost): duplicate by lot id -> fetch -> regex cleaning -> FunPay params -> ONE AI call only if Russian or fields missing -> re-clean + violation check.
- AI field values need a quote that exists in the source; enum/number checked in code.
- Required game fields not found: fill the LOWEST value and report it (`defaulted`); such offers are LISTED IMMEDIATELY, but highlighted and logged.
- Price: read as-is from the page, no currency conversion; multiplier = source price x factor.
- "Blocked" or timed-out source pages are never treated as dead. Dead = two `not_found` results at least 24 h apart; stop the scan if an abnormal share is not_found.
- Local deployment (no always-on host needed because AI is hosted). Vercel Hobby is not allowed for commercial use.
- Plan to support more marketplaces through source adapters (`lib/sources`) and destination adapters. Open question: is Eldorado a source, a destination, or both?

## What exists (slice 1, prepare-only; nothing new publishes or writes the sheet)
lib/sources (FunPay adapter), lib/cleaning, lib/ai (provider chain + extract), lib/gameFields.ts, lib/gameProfile.ts, lib/probeRequired.ts,
lib/pipeline/prepare.ts, app/api/ai/prepare/route.ts, scripts/probe-funpay.ts, tests/ (25 offline tests: `npm test`).

## NOT verified yet (do first)
1. FunPay parser labels were written from the usual layout, never against real pages. Run `npm run probe:funpay -- links.txt --save`
   (links.txt has 21 real links), read `probe-output/report.json` and `probe-output/pages/*.html`, and fix `lib/sources/funpay.ts` + tests/fixtures.ts from the REAL HTML.
   FunPay's robots.txt disallows some automated fetching; throttle (the probe already waits 1.5 s) and treat blocks as unknown.
2. AI path was only tested against a mock. Add a free Groq key (`GROQ_API_KEY`) and `AI_PROVIDERS` in `.env.local`, check model names against the provider's current list.
3. Whether the GameBoost required-field probe really finds required fields for real games.

## Next steps
1. Fix the parser from real pages. 2. `/auto` page: paste `link price seller` lines (dedupe by lot id client-side), call `/api/ai/prepare` in chunks of <=6 with a progress bar,
review table with defaulted fields highlighted, then publish through the existing `POST /api/offers` code path (keeps 422 retry, duplicate-title check, sheet logging).
3. Dead/duplicate bulk-delete queue with rolling re-check (each live offer about every 3 days). 4. Game detection from the FunPay category. 5. Listings tab + destination adapters.

## Rules for working here
- Run `npm test` after changes. Keep new logic pure and injectable so it is testable offline.
- Never commit `.env.local`. Never delete GameBoost offers or edit sheet rows without an explicit user confirmation step in the UI.
- GameBoost limits: writes 500/min, 10/hour per offer. Google Sheets: batch writes.

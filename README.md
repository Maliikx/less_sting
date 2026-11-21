# Less Sting

Internal tool for listing offers. Employees submit offers in a form. Each offer is logged to the
Google Sheet as before and, **new in this version**, created on **GameBoost** as a
**manual-delivery** account offer. The Manage page lets you **edit, unlist/list and delete** those offers.

## What changed

| Area | Before | Now |
|---|---|---|
| Submit form | Logged rows to the sheet only | Creates the offer on GameBoost, then logs it to the sheet with the GameBoost id and status. The "Publish to GameBoost" toggle off = sheet only, as before |
| Edit / delete | Not possible | **Manage GameBoost offers** page: edit title, price, description, images, delivery time and instructions; list/unlist; permanent delete |
| Sheet | Columns A-F | A-F unchanged, plus **G-L**: `GB_OFFER_ID, GB_STATUS, EXTERNAL_ID, GB_PRICE_EUR, GAME, GB_UPDATED_AT` (headers written automatically) |
| Status sync | - | "Refresh sheet from GameBoost" button and `/api/gameboost/sync` for a schedule: pulls sold/edited/deleted status into the sheet |
| Security | Login cookie was literally `auth=true` (anyone could fake it) and **every `/api` route was open to the internet** | Signed, expiring session cookie; all `/api` routes need it. Required now that the API can delete offers |
| Bug fix | The live duplicate check re-ran on every render, so it called the Sheets API about every 400 ms while the page was open | Only runs when a title actually changes |

## Setup

1. Copy `.env.example` to `.env.local` (or set the same variables on your host, e.g. Vercel → Settings → Environment Variables).
2. New variables:
   - `GAMEBOOST_API_KEY`: your existing key (Partner Dashboard → Settings → Developers). Server-side only, never sent to the browser.
   - `SESSION_SECRET`: any long random string (`openssl rand -hex 32`).
   - Optional: `GAMEBOOST_MANUAL_CREDENTIAL_PLACEHOLDER`, `CRON_SECRET`, `GOOGLE_SHEET_TAB`.
3. `npm install`, then `npm run dev` (or deploy as usual). No new npm packages were added.
4. Everyone has to log in once more, because the old cookie is no longer accepted.

## How the sheet is used

```
A LINK | B PRICE | C EMPLOYEE | D TITLE | E NOTE | F CREATED_AT | G GB_OFFER_ID | H GB_STATUS | I EXTERNAL_ID | J GB_PRICE_EUR | K GAME | L GB_UPDATED_AT
```

- The duplicate-title check (column D) and the "offers submitted today" counter (C + F) work exactly as before.
- A row is only written once GameBoost has accepted the offer, so the daily count only counts real listings.
  Offers GameBoost rejects stay in the form with the error shown in red, so they can be fixed and resubmitted.
- Edits made in the app update D (title), H (status), J (price) and L. Deleting keeps the row and sets H to `deleted`, so daily counts and history stay intact.
- Each offer gets an `EXTERNAL_ID` (`ls-<employee>-...`) that links the sheet row to the GameBoost offer.

## Using it

**Create**: pick the employee, then in the blue GameBoost box:
1. Search and pick the **game**. The game's template loads into "Account data (JSON)". Fill in its values (rank, server, ...).
2. Set the **guaranteed delivery time** (required for manual delivery) and a **default description**.
3. Per offer: Link, Title, Price, **Image URLs** (one per line; the first image must show the account; no imgur).
   Price can be a number in EUR or a multiplier like `x2`. For a multiplier, enter the source price and the app calculates the EUR price.
   The sheet still stores what was typed in PRICE.
4. Optional per offer, under "More GameBoost fields": its own description, account-data overrides, credentials.
5. Untick **List immediately** to create offers as hidden drafts and check them on GameBoost first.

Batch settings (game, delivery time, description, account data) are remembered in each browser.

**Edit / Unlist / Delete**: open **Manage GameBoost offers**. Delete needs two clicks and is **permanent**.
Prefer **Unlist** if you might sell the offer later. Offers that are sold, processing or refunded, or that have orders, can't be edited or deleted.

**Keep the sheet in sync** with things that happen on GameBoost (sales, edits on the website):
- Click **Refresh sheet from GameBoost** on the Manage page, or
- Schedule `GET /api/gameboost/sync` with the header `Authorization: Bearer $CRON_SECRET`.
  On Vercel, `vercel.json` already runs it daily (set `CRON_SECRET` in the project). Any external cron service works too.

## Speed features (for ~100 listings a day)

- **Images from the link:** paste the offer link and the app opens the page, takes the account's images and fills "Image URLs".
  If the page has no images it says so, so the employee can paste one. If the offer is already gone it warns right away.
- **Description tag:** every description gets `#<employee>-<last 8 characters of the link>` on its last line, e.g. `#M-43883655`.
- **Emojis:** titles are never blocked. The app adds the space GameBoost search needs after each emoji (`🔥Gold` → `🔥 Gold`).
- **Listing details per game:** picking a game shows its fields (rank, server, ...). Values are remembered per game in each browser,
  so switching games fills everything in from last time. "Reset to template" clears back to GameBoost's template.
- **Price from the link:** the price shown on the source page is read as-is (no currency conversion) into "Source price".
  Type any multiplier in Price (`x2`, `x1.75`, `2x`, `×1.9`) and the app lists source price × multiplier. Check the 💶 line under the link.
- **Required listing details:** the first time a game is picked, the app asks GameBoost which details it requires
  (a request that is always rejected, so nothing is created) and marks them with a red *. Click * / (optional) to switch a
  field by hand; "Detect required fields" asks again.
- **Listing details per offer:** each offer card has its own listing details (counts, level, ...). The panel at the top holds
  the defaults; a card shows them greyed and only stores what you change for that account. Number fields are sent as numbers;
  if GameBoost says a field "must be an integer" the app converts it, retries once automatically, and remembers it for that game.
- **Missing listing details:** if GameBoost says fields like platform or account_level are required, the app adds them to
  "Listing details" (remembered for that game) and tells you which to fill in. You can also add a field by name.
- **Word filter:** words/phrases in the "Word filter" box are removed from every title and description the app lists
  (whole words, any letter case). Saved per browser.
- **Dead links (Manage page):** "Check offer links" opens the source link of every live offer in the sheet and lists the ones showing
  "Offer not found" (or a 404). The check itself changes nothing. Select offers, click Delete or Unlist, then confirm in the box that appears. Links the site blocked or that timed out are listed
  separately and never selected for deletion.

## Built-in checks (from the GameBoost API docs and seller rules)

- Blocked before sending: the words *refund, money-back, replacement, lifetime, no warranty, voided warranty*; imgur images; titles over 255 or descriptions over 2048 characters; prices under €0.99.
- Create is never retried automatically. After a timeout or 5xx the app first looks the offer up by `external_id`, so it can't create duplicates.
- Edits send only the fields that changed. GameBoost allows **10 writes per offer per hour**. If you hit that, wait and retry.
- Credentials returned by GameBoost are stripped before anything reaches the browser.

## Before relying on it: test on one cheap offer

Some GameBoost behaviour isn't documented and could only be tested against a mock here:

1. **Credentials on manual offers.** The API requires at least one credentials entry even for manual delivery. If an employee leaves it empty,
   the app sends the `GAMEBOOST_MANUAL_CREDENTIAL_PLACEHOLDER` text. Check on the test offer that this text is acceptable to GameBoost, and see what a buyer would see.
2. **Status after create.** If offers come back as `pending` (for example under review), "List immediately" shows a warning instead of listing.
3. **Editing images.** The app sends the full image list. Confirm that it replaces the old images rather than adding to them.
4. **Account data.** Fill in the game template's fields correctly, otherwise GameBoost returns a validation error, which is shown on the offer.

Suggested run: untick "List immediately", create 1 offer, check it on GameBoost, edit its price on the Manage page, list it, unlist it, delete it.

## AI pipeline (slice 1: prepare only)

New, read-only building blocks for "paste a FunPay link + price + seller code, get a finished listing":

| Piece | File |
|---|---|
| FunPay page reader (title, description, params, images, price, dead/blocked) | `lib/sources/funpay.ts` |
| Banned words (EN+RU, synonyms), contacts, seller-ad sentences, final check | `lib/cleaning/*` |
| Free hosted AI with fallback chain (Groq, Gemini, local Ollama) | `lib/ai/provider.ts` |
| One AI call per offer: translate, drop ads, read game fields (with evidence check) | `lib/ai/extract.ts` |
| Required game fields not found -> lowest value, reported | `lib/gameFields.ts` |
| Whole flow | `lib/pipeline/prepare.ts`, `POST /api/ai/prepare` |

Nothing is published yet: `/api/ai/prepare` only returns the prepared listings. Publishing still goes through `POST /api/offers`.

### Try it
1. `npm install` (adds `tsx`).
2. Put your real links in `links.txt` (one per line), then `npm run probe:funpay -- links.txt --save`.
   Paste the printed table back so the parser can be matched to the real pages. Pages are saved in `probe-output/pages`.
3. Add `AI_PROVIDERS` and a free `GROQ_API_KEY` to `.env.local` (see `.env.example`).
4. `npm test` runs the offline tests (no network, no keys needed).

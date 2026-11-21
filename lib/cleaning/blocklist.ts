/**
 * Banned terms (English + Russian) and their synonyms. Applied by plain code, so the result never
 * depends on a model "remembering" the rules. Extend with env BLOCKLIST_EXTRA (comma or | separated).
 *
 * Entry syntax:
 *   - words are matched case-insensitively, whole words only
 *   - spaces and hyphens in an entry match any of: space, hyphen, nothing  ("auto delivery" = "auto-delivery" = "autodelivery")
 *   - a trailing * accepts any ending ("guarantee*" = guarantee, guaranteed, guarantees)
 */

export type Group = { reason: string; terms: string[] }

/** Phrases that are removed from the clause they appear in. */
export const TERM_GROUPS: Group[] = [
  {
    reason: "instant/auto delivery",
    terms: [
      "instant", "instantly", "instant deliver*", "instantly deliver*", "immediate deliver*", "immediately deliver*",
      "auto deliver*", "autodeliver*", "automatic deliver*", "automatically deliver*", "auto issue*", "auto delivery system",
      "issued automatically", "automatically issued", "auto issued", "automatic issu*", "delivered automatically", "sent automatically",
      "automatic sending", "auto send*", "выда* автоматически", "автоматически выда*", "автоматическ* отправк*",
      "мгновенн*", "моментальн*", "автовыдач*", "авто выдач*", "автоматическ* выдач*", "автодоставк*", "автоматическ* доставк*",
    ],
  },
  {
    reason: "guarantee/warranty",
    terms: [
      "guarantee*", "guaranty", "warrant*", "money back", "100% safe", "no warranty", "voided warranty", "lifetime",
      "гаранти*", "гарант", "гарантирую", "гарантируем",
    ],
  },
  {
    reason: "personal account",
    terms: [
      "personal account*", "personal acc", "personal acc*", "my personal", "own account", "my own account",
      "личн* аккаунт*", "личн* акк*", "собственн* аккаунт*", "мой личный",
    ],
  },
  {
    reason: "marketplace name",
    terms: [
      "funpay", "fun pay", "playerok", "eldorado", "eldorado.gg", "g2g", "u7buy", "z2u", "plati", "plati.market", "gamivo", "g2a",
      "kinguin", "mmoga", "zeusx", "ggsel", "digiseller", "lolz", "lolzteam", "lzt", "zelenka", "gameboost",
      "фанпей*", "фанпэй*", "плеерок", "плати", "ггсел", "лолз", "зеленка",
    ],
  },
  {
    reason: "refund/replacement",
    terms: [
      "refund*", "money-back", "replacement*", "return policy", "no return*", "no money back", "returns", "chargeback*",
      "возврат*", "верн* деньги", "верну деньги", "замен*",
    ],
  },
]

/** A sentence containing any of these is dropped completely (contact details, seller advertising, seller policy). */
export const SENTENCE_PATTERNS: { reason: string; re: RegExp }[] = [
  {
    // The seller's own sales policy / instructions to buyers (not facts about the account).
    reason: "seller policy",
    re: new RegExp(
      "(?<![\\p{L}\\p{N}])(?:" +
        [
          "(?:make|record|film|take)\\s+(?:a\\s+)?(?:video|recording)", "video\\s*record\\p{L}*", "screen\\s*record\\p{L}*",
          "(?:no|not|without|never)\\s+(?:a\\s+)?returns?", "there will be no (?:return|refund|compensation)\\p{L}*",
          "(?:is|are|will be)\\s+(?:issued|delivered|sent)\\s+automatically", "(?:data|account|login|credentials?)\\s+(?:is|are)\\s+issued",
          "before\\s+(?:purchas|buy|order)\\p{L}*[^.!?\\n]{0,40}(?:ask|write|message|contact|clarify|check with)",
          "(?:ask|write|message|contact)\\s+(?:me|us|the seller)\\s+before",
          "not responsible", "no claims?", "at your own risk", "after (?:the )?purchase[^.!?\\n]{0,30}(?:write|message|contact|confirm)",
          "(?:please\\s+)?(?:leave|write)\\s+(?:a\\s+)?(?:review|feedback)", "confirm (?:the )?(?:order|purchase)",
          "видеозапис\\p{L}*", "запиш\\p{L}*\\s+видео", "сним\\p{L}*\\s+видео", "возврат\\p{L}*\\s+(?:не|нет)", "без\\s+возврат\\p{L}*",
          "выда\\p{L}*\\s+автоматически", "перед\\s+покупк\\p{L}*", "подтверд\\p{L}*\\s+заказ",
        ].join("|") +
        ")(?![\\p{L}\\p{N}])",
      "iu"
    ),
  },
  {
    // Greetings and introductions of the seller's store (the buyer sees GameBoost, not that store).
    reason: "store introduction",
    re: new RegExp(
      "(?<![\\p{L}\\p{N}])(?:" +
        [
          "welcome(?:\\s+to)?", "hello", "hi there", "hey there", "greetings", "dear (?:buyers?|customers?|friends?)",
          "(?:my|our|this)\\s+(?:store|shop|team|channel)", "in (?:my|our) (?:store|shop)", "thank(?:s| you) for (?:choosing|visiting|your|purchas\\p{L}*|buying)",
          "i am (?:a |the )?seller", "we are (?:a |the )?(?:team|shop|store|seller)", "check (?:out )?my other", "other (?:offers|lots|accounts) in my",
          "привет\\p{L}*", "здравствуй\\p{L}*", "добро пожаловать", "(?:мой|наш|моём|нашем)\\s+магазин\\p{L}*", "другие (?:лоты|предложения|аккаунты)",
        ].join("|") +
        ")(?![\\p{L}\\p{N}])",
      "iu"
    ),
  },
  { reason: "link", re: /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|net|org|gg|io|ru|me|market|shop|store|to|ly|tv|co|su|ua|by)\b/iu },
  { reason: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/u },
  { reason: "handle", re: /(?<![\w@])@[A-Za-z0-9_]{3,}/u },
  { reason: "phone", re: /\+\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{10,13}\b/u },
  {
    reason: "messenger",
    re: /(?<![\p{L}\p{N}])(?:telegram|whatsapp|whats app|discord|skype|viber|wechat|signal|instagram|t\.me|тг|телеграм\p{L}*|вотсап\p{L}*|ватсап\p{L}*|дискорд\p{L}*|вайбер\p{L}*)(?![\p{L}\p{N}])/iu,
  },
  {
    reason: "seller advertising",
    re: new RegExp(
      "(?<![\\p{L}\\p{N}])(?:" +
        [
          "reviews?", "feedbacks?", "trusted seller", "reliable seller", "best seller", "top seller", "best price", "lowest price", "cheapest",
          "(?:write|message|contact|dm|pm|text|add)\\s+me", "ask me", "feel free", "any questions?", "24/7", "online now", "thank you", "thanks for",
          "отзыв\\p{L}*", "надеж\\p{L}*\\s+продав\\p{L}*", "надёж\\p{L}*\\s+продав\\p{L}*", "лучш\\p{L}*\\s+(?:цен\\p{L}*|продав\\p{L}*)",
          "пиши\\p{L}*", "пишите", "обращайтесь", "спасибо", "любые вопросы", "в лс", "в личку", "круглосуточно",
        ].join("|") +
        ")(?![\\p{L}\\p{N}])",
      "iu"
    ),
  },
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** "auto delivery*" -> regex source. */
export function entryToRegexSource(entry: string): string {
  const wild = entry.endsWith("*")
  const body = wild ? entry.slice(0, -1) : entry
  const tokens = body.split(/[\s-]+/).filter(Boolean).map(t => {
    const w = t.endsWith("*") ? t.slice(0, -1) : t
    return escapeRe(w) + (t.endsWith("*") ? "\\p{L}*" : "")
  })
  return tokens.join("[\\s\\-]*") + (wild ? "\\p{L}*" : "") + "(?:\\.[a-z]{2,6})?"
}

export type CompiledTerms = { reason: string; re: RegExp }[]

export function compileTerms(extra?: string): CompiledTerms {
  const groups: Group[] = [...TERM_GROUPS]
  const extras = String(extra ?? process.env.BLOCKLIST_EXTRA ?? "")
    .split(/[|,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
  if (extras.length) groups.push({ reason: "custom blocklist", terms: extras })
  return groups.map(g => ({
    reason: g.reason,
    re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${g.terms.map(entryToRegexSource).join("|")})(?![\\p{L}\\p{N}])`, "giu"),
  }))
}

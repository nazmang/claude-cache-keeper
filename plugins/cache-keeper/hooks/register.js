// cache-keeper: compacts an idle session before its prompt cache expires.
//
// The prompt cache lives 1 hour from the last request to the model. A session
// that wakes up after an hour of idling writes its whole context into the cache
// again at full price. A /compact done a few minutes before expiry still reads
// the context from the cache (cheap) and leaves a short summary, so the next
// wake-up costs next to nothing.
//
// When the person sends a message into a session whose cache has already
// expired, the mod asks first: compact then send, send as is, or keep the
// draft. A cold send rewrites the whole context into the cache.
//
// Each session compacts only itself, so there is no shared loop to coordinate.
// Fallback for sessions started without the mod: `cache-keeper-idle` from a
// systemd timer (window 53-59 min). The mod fires earlier, so the timer then
// sees nothing left to compact.

// Thresholds can be moved with environment variables (handy for a live test).
let CACHE_MIN = 60
let COMPACT_AT_MIN = 50        // minutes of idling before compacting
let MIN_TOKENS = 60000         // below this, compacting is not worth it
let TICK_MS = 60 * 1000

let lastRequest = 0            // set on load: assume the cache is fresh
let compacting = false
let lastNote = ''
let stopTick = null
let lastFailed = false

// --- language --------------------------------------------------------------
// AGENTS_LANG (ru|en) wins; otherwise the first non-empty of LC_ALL,
// LC_MESSAGES, LANG: "ru..." is Russian, anything else English. Picked once,
// when the session starts. Only text a person reads is translated.
let LANG = 'en'

async function pickLang($) {
  // $.env.get wants a literal name: the mod's variables must be listable
  const forced = String((await $.env.get('AGENTS_LANG')) ?? '').trim().toLowerCase()
  if (forced === 'ru' || forced === 'en') return forced
  const loc = String((await $.env.get('LC_ALL')) ?? '').trim() ||
    String((await $.env.get('LC_MESSAGES')) ?? '').trim() ||
    String((await $.env.get('LANG')) ?? '').trim()
  return /^ru/i.test(loc) ? 'ru' : 'en'
}

export const STRINGS = {
  en: {
    cmd_desc: 'How long the prompt cache has left and when the session will compact itself',
    skipped: 'compaction skipped: {why}',
    compacted: 'compacted after {min} min idle (was {k}k)',
    failed: 'compaction failed: {err}',
    cold_compacted: 'compacted before a cold send (was {k}k)',
    press_enter: '{note} - press Enter to send your message',
    cold_failed: 'compaction failed: {err} - press Enter to send as is',
    ask: 'The prompt cache expired {min} min ago. Sending now writes the whole context (~{k}k tokens) into the cache again at full price. What should happen?',
    header: 'cold cache',
    compact_send: 'Compact, then send',
    send: 'Send as is',
    keep: 'Do not send',
    drop_compact: 'cache-keeper: compacting first; press Enter again once it says done',
    drop_keep: 'cache-keeper: not sent (cold cache); the text stays in the input box',
    report: 'cache left ~{left} min; context {k}k; {plan}',
    last: 'last: {note}',
    plan_small: 'context is below the {k}k threshold - will not compact',
    plan_after: 'will compact after {n} more min idle',
    plan_open: 'compaction window is open',
  },
  ru: {
    cmd_desc: 'Сколько ещё живёт кэш промпта и когда сессия сожмёт себя сама',
    skipped: 'сжатие пропущено: {why}',
    compacted: 'сжато после {min} мин простоя (было {k}k)',
    failed: 'сжать не вышло: {err}',
    cold_compacted: 'сжато перед холодной отправкой (было {k}k)',
    press_enter: '{note} - жми Enter, сообщение уйдёт',
    cold_failed: 'сжать не вышло: {err} - жми Enter, отправится как есть',
    ask: 'Кэш промпта истёк {min} мин назад. Если отправить сейчас, весь контекст (~{k}k токенов) снова запишется в кэш по полной цене. Что делаем?',
    header: 'холодный кэш',
    compact_send: 'Сжать и отправить',
    send: 'Отправить как есть',
    keep: 'Не отправлять',
    drop_compact: 'cache-keeper: сначала сжимаю; когда напишу «готово», жми Enter ещё раз',
    drop_keep: 'cache-keeper: не отправлено (кэш холодный); текст остался в поле ввода',
    report: 'кэш: осталось ~{left} мин; контекст {k}k; {plan}',
    last: 'последнее: {note}',
    plan_small: 'контекст меньше порога {k}k - сжимать не буду',
    plan_after: 'сожму через {n} мин простоя',
    plan_open: 'окно сжатия открыто',
  },
}

export function t(key, vars = {}) {
  const tpl = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}

async function minutesIdle($) {
  return ((await $.clock.now()) - lastRequest) / 60000
}

async function tick($) {
  if (compacting) return
  compacting = true   // before the first await: ticks must not overlap
  try {
    const idle = await minutesIdle($)
    if (idle < COMPACT_AT_MIN || idle >= CACHE_MIN) return
    const usage = await $.session.usage()
    const tokens = usage.context?.tokens ?? 0
    if (tokens < MIN_TOKENS) return
    await compactNow($, idle, tokens)
  } finally {
    compacting = false
  }
}

async function compactNow($, idle, tokens) {
  try {
    const res = await $.session.compact()
    lastFailed = false
    lastNote = res && res.skip
      ? t('skipped', { why: res.skip })
      : t('compacted', { min: Math.round(idle), k: Math.round(tokens / 1000) })
    $.ui.log(lastNote)
  } catch (err) {
    // compact refuses while a turn is running (that is exactly the guard
    // against compacting mid-work) - try again on the next tick
    lastFailed = true
    lastNote = t('failed', { err: err?.message ?? err })
  }
  if (!lastFailed) lastRequest = (await $.clock.now())
}

// Who typed it: only a person at the prompt (or on the phone bridge) can
// answer a question; peers, task notifications and triggers pass untouched.
const HUMAN = new Set(['composer', 'bridge'])

// Should a submission be stopped for the cold-cache question?
export function coldVerdict({ idleMin, tokens, origin, turnId, cacheMin, minTokens }) {
  if (!origin || !HUMAN.has(origin.kind)) return false
  if (turnId) return false                 // typed into a running turn: cache is warm
  if (idleMin < cacheMin) return false
  return tokens >= minTokens
}

function compactThenTell($, k) {
  ;(async () => {
    await $.clock.sleep(300)
    try {
      await $.session.compact()
      lastRequest = await $.clock.now()
      lastNote = t('cold_compacted', { k })
      $.ui.log(t('press_enter', { note: lastNote }))
    } catch (err) {
      $.ui.log(t('cold_failed', { err: err?.message ?? err }))
    }
  })()
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    LANG = await pickLang($)
    await $.command.register({
      name: 'cache',
      description: t('cmd_desc'),
    })
    const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d)
    CACHE_MIN = num(await $.env.get('CACHE_KEEPER_CACHE_MIN'), CACHE_MIN)
    COMPACT_AT_MIN = num(await $.env.get('CACHE_KEEPER_AT_MIN'), COMPACT_AT_MIN)
    MIN_TOKENS = num(await $.env.get('CACHE_KEEPER_MIN_TOKENS'), MIN_TOKENS)
    TICK_MS = num(await $.env.get('CACHE_KEEPER_TICK_MS'), TICK_MS)
    lastRequest = (await $.clock.now())
    if (stopTick) stopTick.cancel()
    stopTick = $.clock.every(TICK_MS, () => tick($))
    return next(e)
  })

  // A main-thread request to the model refreshes the cache. Subagents have their own.
  on('turn.start', async ($, e, next) => {
    lastRequest = (await $.clock.now())
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) lastRequest = (await $.clock.now())
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const idle = await minutesIdle($)
    let tokens = 0
    try { tokens = (await $.session.usage()).context?.tokens ?? 0 } catch { tokens = 0 }
    if (!coldVerdict({ idleMin: idle, tokens, origin: e.origin, turnId: e.turnId,
      cacheMin: CACHE_MIN, minTokens: MIN_TOKENS })) return next(e)
    const k = Math.round(tokens / 1000)
    const [COMPACT_SEND, SEND, KEEP] = [t('compact_send'), t('send'), t('keep')]
    let answer = ''
    try {
      answer = await $.ui.ask(t('ask', { min: Math.round(idle - CACHE_MIN), k }),
        { header: t('header'), options: [COMPACT_SEND, SEND, KEEP] })
    } catch {
      answer = KEEP
    }
    if (answer === SEND) return next(e)
    if (answer === COMPACT_SEND) {
      // compact cannot run under the turn this hook holds: drop the prompt
      // (the engine puts the text back into the input box), compact right
      // after, then the person presses Enter again into a small context
      compactThenTell($, k)
      return { drop: t('drop_compact') }
    }
    // the engine puts a dropped prompt back into the input box by itself
    return { drop: t('drop_keep') }
  })

  on('command.run', { command: 'cache' }, async ($) => {
    const idle = await minutesIdle($)
    const left = Math.max(0, CACHE_MIN - idle)
    const usage = await $.session.usage()
    const tokens = Math.round((usage.context?.tokens ?? 0) / 1000)
    const plan = tokens * 1000 < MIN_TOKENS
      ? t('plan_small', { k: MIN_TOKENS / 1000 })
      : idle < COMPACT_AT_MIN
        ? t('plan_after', { n: Math.ceil(COMPACT_AT_MIN - idle) })
        : t('plan_open')
    return {
      text: t('report', { left: Math.floor(left), k: tokens, plan }) +
        (lastNote ? `\n${t('last', { note: lastNote })}` : ''),
    }
  })
}

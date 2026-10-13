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
// Fallback for sessions started without the mod: `agents compact-idle` from a
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
    lastNote = res && res.skip
      ? `compaction skipped: ${res.skip}`
      : `compacted after ${Math.round(idle)} min idle (was ${Math.round(tokens / 1000)}k)`
    $.ui.log(lastNote)
  } catch (err) {
    // compact refuses while a turn is running (that is exactly the guard
    // against compacting mid-work) - try again on the next tick
    lastNote = `compaction failed: ${err?.message ?? err}`
  }
  if (!lastNote.startsWith('compaction failed')) lastRequest = (await $.clock.now())
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

export const COMPACT_SEND = 'Compact, then send'
export const SEND = 'Send as is'
export const KEEP = 'Do not send'

function compactThenTell($, k) {
  ;(async () => {
    await $.clock.sleep(300)
    try {
      await $.session.compact()
      lastRequest = await $.clock.now()
      lastNote = `compacted before a cold send (was ${k}k)`
      $.ui.log(`${lastNote} - press Enter to send your message`)
    } catch (err) {
      $.ui.log(`compaction failed: ${err?.message ?? err} - press Enter to send as is`)
    }
  })()
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'How long the prompt cache has left and when the session will compact itself',
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
    let answer = ''
    try {
      answer = await $.ui.ask(
        `The prompt cache expired ${Math.round(idle - CACHE_MIN)} min ago. Sending now writes the whole ` +
        `context (~${k}k tokens) into the cache again at full price. What should happen?`,
        { header: 'cold cache', options: [COMPACT_SEND, SEND, KEEP] })
    } catch {
      answer = KEEP
    }
    if (answer === SEND) return next(e)
    if (answer === COMPACT_SEND) {
      // compact cannot run under the turn this hook holds: drop the prompt
      // (the engine puts the text back into the input box), compact right
      // after, then the person presses Enter again into a small context
      compactThenTell($, k)
      return { drop: 'cache-keeper: compacting first; press Enter again once it says done' }
    }
    // the engine puts a dropped prompt back into the input box by itself
    return { drop: 'cache-keeper: not sent (cold cache); the text stays in the input box' }
  })

  on('command.run', { command: 'cache' }, async ($) => {
    const idle = await minutesIdle($)
    const left = Math.max(0, CACHE_MIN - idle)
    const usage = await $.session.usage()
    const tokens = Math.round((usage.context?.tokens ?? 0) / 1000)
    const plan = tokens * 1000 < MIN_TOKENS
      ? `context is below the ${MIN_TOKENS / 1000}k threshold - will not compact`
      : idle < COMPACT_AT_MIN
        ? `will compact after ${Math.ceil(COMPACT_AT_MIN - idle)} more min idle`
        : 'compaction window is open'
    return {
      text: `cache left ~${Math.floor(left)} min; context ${tokens}k; ${plan}` +
        (lastNote ? `\nlast: ${lastNote}` : ''),
    }
  })
}

// cache-keeper: compacts an idle session before its prompt cache expires.
//
// The prompt cache lives 1 hour from the last request to the model. A session
// that wakes up after an hour of idling writes its whole context into the cache
// again at full price. A /compact done a few minutes before expiry still reads
// the context from the cache (cheap) and leaves a short summary, so the next
// wake-up costs next to nothing.
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

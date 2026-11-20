import { expect, mock, test } from 'claude-code/testing'
import { chooseLang, coldVerdict, STRINGS } from '../hooks/register.js'

const MIN = 60_000

// Shared harness: clock, command registration, log, usage and a compact counter
function setup(on, tokens: number, compactSkip?: string, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  const calls = { compact: 0, logs: [] as string[] }
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', ($, e) => { calls.logs.push(e.text); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: tokens / 10_000 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.compact', ($, e) => {
    calls.compact += 1
    return compactSkip ? { skip: compactSkip } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, calls }
}

test('a large context is compacted at minute 50 of idling, once', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(49 * MIN)
  expect(calls.compact).toBe(0)
  await clock.advance(2 * MIN)
  expect(calls.compact).toBe(1)
  expect(calls.logs[0]).toMatch(/compacted after 5\d min idle/)
  // after compaction the countdown restarts - nothing more until the next window
  await clock.advance(9 * MIN)
  expect(calls.compact).toBe(1)
})

test('a small context is left alone', async ($, on) => {
  const { clock, calls } = setup(on, 30_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(58 * MIN)
  expect(calls.compact).toBe(0)
})

test('activity restarts the countdown', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(45 * MIN)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(10 * MIN)
  expect(calls.compact).toBe(0)
  await clock.advance(41 * MIN)
  expect(calls.compact).toBe(1)
})

test('a subagent turn does not restart the countdown', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(45 * MIN)
  await $.turn.start({ turnId: 's1', agentId: 'sub1', prompt: 'x' } as any)
  await $.turn.complete({ turnId: 's1', agentId: 'sub1', answer: 'ok', durationMs: 1000, isAborted: false, usage: null } as any)
  await clock.advance(6 * MIN)
  expect(calls.compact).toBe(1)
})

test('hours of idling - one compaction, never a summary of a summary', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // the usage stub keeps reporting 200k after compaction: the context stays
  // above the threshold, and yet nothing new has happened to summarise
  await clock.advance(6 * 60 * MIN)
  expect(calls.compact).toBe(1)
})

test('main-thread activity after a compaction re-arms it', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.compact).toBe(1)
  await clock.advance(30 * MIN)
  await $.turn.start({ turnId: 't1', prompt: 'x' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(51 * MIN)
  expect(calls.compact).toBe(2)
})

test('/cache says when it has already compacted and waits for activity', async ($, on) => {
  const { clock } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/already compacted - waits for new activity/)
})

test('a subagent turn after a compaction does not re-arm it', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  await $.turn.complete({ turnId: 's1', agentId: 'sub1', answer: 'ok', durationMs: 1000, isAborted: false, usage: null } as any)
  await clock.advance(120 * MIN)
  expect(calls.compact).toBe(1)
})

test('compaction skipped by another hook - log the reason', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, 'busy')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.compact).toBe(1)
  expect(calls.logs[0]).toMatch(/compaction skipped: busy/)
})

test('a skipped compaction is not a request - the cache still expires at 60', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, 'busy')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.compact).toBe(1)
  await clock.advance(10 * MIN)
  expect(calls.compact).toBe(1)   // no retry every minute after a skip
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache left ~0 min; context 200k; cache has expired/)
})

test('a cold-path compaction skipped by another hook leaves the cache expired', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, 'busy', { CACHE_KEEPER_AT_MIN: '1000' })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e: any) => {
    const qs = (e.input ?? e).questions ?? []
    return { result: { questions: qs, answers: Object.fromEntries(qs.map(q => [q.question, 'Compact, then send'])) } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(75 * MIN)
  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  expect((r as any).drop).toMatch(/compacting first/)
  await clock.advance(1000)
  expect(calls.compact).toBe(1)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache has expired/)
})

test('a resumed session counts from its last response, not from the restart', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 45 * 60 } as any)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache left ~15 min/)
  await clock.advance(6 * MIN)
  expect(calls.compact).toBe(1)
})

test('resume info that arrives before session.start is kept', async ($, on) => {
  const { clock } = setup(on, 200_000)
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 60 * 60 } as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache has expired/)
})

test('/cache reports the cache state', async ($, on) => {
  const { clock } = setup(on, 120_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache left ~40 min; context 120k; will compact after 30 more min idle/)
})

test('/cache speaks Russian under a Russian locale', async ($, on) => {
  const { clock } = setup(on, 120_000, undefined, { LANG: 'ru_RU.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/кэш: осталось ~40 мин; контекст 120k; сожму через 30 мин простоя/)
})

test('AGENTS_LANG beats the locale, LC_ALL beats LANG, C means English', async ($, on) => {
  const { clock } = setup(on, 120_000, undefined, { AGENTS_LANG: 'en', LANG: 'ru_RU.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  expect((await $.command.run({ command: 'cache', args: '' })).text).toMatch(/^cache left ~40 min/)
})

test('LC_ALL=C overrides a Russian LANG', async ($, on) => {
  const { clock } = setup(on, 120_000, undefined, { LC_ALL: 'C', LANG: 'ru_RU.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  expect((await $.command.run({ command: 'cache', args: '' })).text).toMatch(/^cache left ~40 min/)
})

test('the compaction log is Russian too', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, undefined, { AGENTS_LANG: 'ru' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.logs[0]).toMatch(/сжато после 5\d мин простоя/)
})

test('compact refused (turn running) - retry every minute, but not past the hour', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  let attempts = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.compact', () => { attempts += 1; throw new Error('turn running') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(120 * MIN)
  expect(attempts).toBe(10)   // minutes 50..59
})

test('thresholds from the environment', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CACHE_KEEPER_AT_MIN: '2', CACHE_KEEPER_MIN_TOKENS: '10', CACHE_KEEPER_TICK_MS: '10000' })
  let n = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 500, window: 1_000_000, percent: 0 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.compact', () => { n += 1; return { messages: [{ role: 'user', text: 's', toolUses: [] }] } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2 * MIN + 10_000)
  expect(n).toBe(1)
})

test('cold-cache question only for a person, an idle session and a big context', async () => {
  const base = { idleMin: 75, tokens: 200_000, origin: { kind: 'composer' }, turnId: undefined, cacheMin: 60, minTokens: 60_000 }
  expect(coldVerdict(base)).toBe(true)
  expect(coldVerdict({ ...base, origin: { kind: 'bridge' } })).toBe(true)
  expect(coldVerdict({ ...base, origin: { kind: 'peer' } })).toBe(false)
  expect(coldVerdict({ ...base, origin: { kind: 'task-notification' } })).toBe(false)
  expect(coldVerdict({ ...base, idleMin: 30 })).toBe(false)
  expect(coldVerdict({ ...base, tokens: 10_000 })).toBe(false)
  expect(coldVerdict({ ...base, turnId: 't1' })).toBe(false)
})

test('/cache says so when the cache has already expired', async ($, on) => {
  // compaction window moved past the TTL: the session just goes cold
  const { clock, calls } = setup(on, 120_000, undefined, { CACHE_KEEPER_AT_MIN: '1000' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(75 * MIN)
  expect(calls.compact).toBe(0)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache left ~0 min; context 120k; cache has expired/)
})

test('/cache speaks Ukrainian under a Ukrainian locale', async ($, on) => {
  const { clock } = setup(on, 120_000, undefined, { LANG: 'uk_UA.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/кеш: лишилося ~40 хв; контекст 120k; стисну через 30 хв простою/)
})

test('AGENTS_LANG=uk beats a Russian locale; the log is Ukrainian too', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, undefined, { AGENTS_LANG: 'uk', LANG: 'ru_RU.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.logs[0]).toMatch(/стиснуто після 5\d хв простою/)
})

test('an unsupported AGENTS_LANG falls back to the locale, then English', async ($, on) => {
  const { clock } = setup(on, 120_000, undefined, { AGENTS_LANG: 'de', LANG: 'de_DE.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  expect((await $.command.run({ command: 'cache', args: '' })).text).toMatch(/^cache left ~40 min/)
})

test('language pick: keys of STRINGS, locale language part, English otherwise', async () => {
  expect(chooseLang('', '', '', 'uk_UA.UTF-8')).toBe('uk')
  expect(chooseLang('', '', '', 'ru_RU')).toBe('ru')
  expect(chooseLang('uk', '', '', 'ru_RU.UTF-8')).toBe('uk')
  expect(chooseLang('de', '', '', 'uk_UA.UTF-8')).toBe('uk')
  expect(chooseLang('de', '', '', '')).toBe('en')
  expect(chooseLang('', 'C', '', 'uk_UA.UTF-8')).toBe('en')
  expect(chooseLang('', '', 'uk_UA.UTF-8', 'ru_RU.UTF-8')).toBe('uk')
  expect(chooseLang(undefined, undefined, undefined, undefined)).toBe('en')
})

test('every language has exactly the English keys and placeholders', async () => {
  const en = Object.keys(STRINGS.en).sort()
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',')
  for (const lang of ['ru', 'uk']) {
    expect(Object.keys(STRINGS[lang]).sort()).toEqual(en)
    for (const k of en) expect(`${lang}.${k}:${ph(STRINGS[lang][k])}`).toBe(`${lang}.${k}:${ph(STRINGS.en[k])}`)
  }
})

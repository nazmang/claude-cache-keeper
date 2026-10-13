import { expect, mock, test } from 'claude-code/testing'
import { coldVerdict } from '../hooks/register.js'

const MIN = 60_000

// Shared harness: clock, command registration, log, usage and a compact counter
function setup(on, tokens: number, compactSkip?: string) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
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

test('two idle hours - one compaction per window', async ($, on) => {
  const { clock, calls } = setup(on, 200_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(120 * MIN)
  // the second window opens 50 min after the first compaction; the usage stub
  // still reports 200k - in real life the context is small after compaction
  expect(calls.compact).toBe(2)
})

test('compaction skipped by another hook - log the reason', async ($, on) => {
  const { clock, calls } = setup(on, 200_000, 'busy')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(51 * MIN)
  expect(calls.compact).toBe(1)
  expect(calls.logs[0]).toMatch(/compaction skipped: busy/)
})

test('/cache reports the cache state', async ($, on) => {
  const { clock } = setup(on, 120_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(20 * MIN)
  const a = await $.command.run({ command: 'cache', args: '' })
  expect(a.text).toMatch(/cache left ~40 min; context 120k; will compact after 30 more min idle/)
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

import { expect, mock, test } from 'claude-code/testing'
import { destBranch, findPushes, NO, STRINGS, YES } from '../hooks/register.js'

test('finds pushes behind cd, -C and env prefixes', async () => {
  expect(findPushes('cd repo && git push')).toEqual([{ dir: 'repo', remote: 'origin', refs: [], skip: false }])
  expect(findPushes('git -C /x/y push origin feat/a')[0]).toEqual({ dir: '/x/y', remote: 'origin', refs: ['feat/a'], skip: false })
  expect(findPushes('GIT_SSH_COMMAND="ssh -v" git push -u origin HEAD')[0].refs).toEqual(['HEAD'])
  expect(findPushes('git commit -m "push it" && git status')).toEqual([])
  expect(findPushes('git push --delete origin old')[0].skip).toBe(true)
  expect(findPushes('git push origin --tags')[0].skip).toBe(true)
})

test('maps refspecs to destination branches', async () => {
  expect(destBranch('feat/a')).toBe('feat/a')
  expect(destBranch('HEAD:refs/heads/feat/b')).toBe('feat/b')
  expect(destBranch('+local:remote')).toBe('remote')
  expect(destBranch(':gone')).toBe(null)
  expect(destBranch('refs/tags/v1')).toBe(null)
})

// gh answers per branch; git rev-parse answers the current branch
// answer: what the person picks in the dialog; null = dismissed
function setup(on, prsByBranch: Record<string, unknown[]>, current = 'feat/x', ghFails = false, answer: string | null = NO, env: Record<string, string> = {}) {
  mock.env(on, { HOME: '/home/u', PUSH_GUARD_ASK_MIN: '1', ...env })
  on('ui.notify', () => ({ value: { isShown: true } }))
  const ran: string[][] = []
  const logs: string[] = []
  let toolRan = 0
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: current + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (ghFails) return { value: { exitCode: 1, stdout: '', stderr: 'not a github repo', isStdoutTruncated: false, isStderrTruncated: false } }
    const b = e.argv[e.argv.indexOf('--head') + 1]
    return { value: { exitCode: 0, stdout: JSON.stringify(prsByBranch[b] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const asked: string[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      asked.push(q)
      if (answer === null) throw new Error('dismissed')
      if (answer === 'HANG') return new Promise(() => {})
      return { result: { questions: e.questions, answers: { [q]: answer } } }
    }
    toolRan += 1
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return { ran, logs, asked, ran_tool: () => toolRan }
}

const merged = [{ number: 71, state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z', baseRefName: 'main' }]

test('asks the person; "no" refuses the push', async ($, on) => {
  const s = setup(on, { 'feat/x': merged })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(s.asked[0]).toMatch(/'feat\/x' is already merged into 'main' \(PR #71\)/)
  expect(r.deny).toMatch(/already merged into 'main' \(PR #71, 2026-10-12\); the user declined/)
  expect(r.deny).not.toMatch(/PUSH_GUARD/)
  expect(s.ran_tool()).toBe(0)
  expect(s.logs[0]).toMatch(/refused/)
})

test('"yes" from the person lets the push run', async ($, on) => {
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, YES)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toBeUndefined()
  expect(s.ran_tool()).toBe(1)
})

test('a dismissed dialog refuses', async ($, on) => {
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, null)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toMatch(/nobody confirmed/)
  expect(s.ran_tool()).toBe(0)
})

test('the model cannot switch the guard off from the command', async ($, on) => {
  const s = setup(on, { 'feat/x': merged })
  const r = await $.tool.call({ tool: 'Bash', command: 'PUSH_GUARD=off git push' })
  expect(r.deny).toMatch(/declined/)
  expect(s.ran_tool()).toBe(0)
})

test('lets through when an open PR uses the same head', async ($, on) => {
  const s = setup(on, { 'feat/x': [...merged, { number: 80, state: 'OPEN', mergedAt: null, baseRefName: 'main' }] })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin feat/x' })
  expect(r.deny).toBeUndefined()
  expect(s.ran_tool()).toBe(1)
})

test('lets through unmerged branches, main and other commands', async ($, on) => {
  const s = setup(on, { 'feat/x': merged, 'feat/new': [] })
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin feat/new' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).deny).toBeUndefined()
  expect(s.ran_tool()).toBe(3)
})

test('passes when gh cannot answer', async ($, on) => {
  const s = setup(on, {}, 'feat/x', true)
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeUndefined()
  expect(s.ran_tool()).toBe(1)
})

test('checks the right directory for cd and -C', async ($, on) => {
  const s = setup(on, { 'feat/x': merged })
  await $.tool.call({ tool: 'Bash', command: 'cd ~/src/app && git push' })
  expect(s.ran.some((a) => a[0] === 'gh')).toBe(true)
  const r = await $.tool.call({ tool: 'Bash', command: 'git -C sub push origin HEAD:feat/x' })
  expect(r.deny).toMatch(/feat\/x/)
})

test('splits on background & and keeps redirects harmless', async () => {
  expect(findPushes('sleep 1 & git push origin feat/a')[0].refs).toEqual(['feat/a'])
  expect(findPushes('git push origin feat/a 2>&1 | tail -3')[0].refs).toEqual(['feat/a'])
})

test('no answer in time refuses instead of hanging', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, 'HANG')
  const p = $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(61_000)
  const r = await p
  expect(r.deny).toMatch(/nobody answered within 1 min/)
  expect(s.ran_tool()).toBe(0)
})

test('a Russian locale: question, options and log in Russian, the refusal for the model stays English', async ($, on) => {
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, STRINGS.ru.no, { LANG: 'ru_RU.UTF-8' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(s.asked[0]).toMatch(/ветка 'feat\/x' уже влита в 'main' \(PR #71\)/)
  expect(s.logs[0]).toMatch(/отклонён/)
  expect(r.deny).toMatch(/was already merged into 'main'.*the user declined the push/)
})

test('a Russian "yes" lets the push run; AGENTS_LANG=en beats a Russian LANG', async ($, on) => {
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, STRINGS.ru.yes, { AGENTS_LANG: 'ru' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toBeUndefined()
  expect(s.ran_tool()).toBe(1)
})

test('AGENTS_LANG=en beats a Russian LANG', async ($, on) => {
  const s = setup(on, { 'feat/x': merged }, 'feat/x', false, NO, { AGENTS_LANG: 'en', LANG: 'ru_RU.UTF-8' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(s.asked[0]).toMatch(/is already merged into 'main'/)
})

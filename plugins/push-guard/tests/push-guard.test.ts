import { expect, mock, test } from 'claude-code/testing'
import { destBranch, findPushes } from '../hooks/register.js'

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
function setup(on, prsByBranch: Record<string, unknown[]>, current = 'feat/x', ghFails = false) {
  mock.env(on, { HOME: '/home/u' })
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
  on('tool.call', () => { toolRan += 1; return { result: { stdout: 'ok', stderr: '', interrupted: false } } })
  return { ran, logs, ran_tool: () => toolRan }
}

const merged = [{ number: 71, state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z', baseRefName: 'main' }]

test('refuses a push to a merged branch', async ($, on) => {
  const s = setup(on, { 'feat/x': merged })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toMatch(/already merged into 'main' \(PR #71, 2026-10-12\)/)
  expect(s.ran_tool()).toBe(0)
  expect(s.logs[0]).toMatch(/refused/)
})

test('lets through when an open PR uses the same head', async ($, on) => {
  const s = setup(on, { 'feat/x': [...merged, { number: 80, state: 'OPEN', mergedAt: null, baseRefName: 'main' }] })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin feat/x' })
  expect(r.deny).toBeUndefined()
  expect(s.ran_tool()).toBe(1)
})

test('lets through unmerged branches, main, overrides and unknown repos', async ($, on) => {
  const s = setup(on, { 'feat/x': merged, 'feat/new': [] })
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin feat/new' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'PUSH_GUARD=off git push' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).deny).toBeUndefined()
  expect(s.ran_tool()).toBe(4)
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

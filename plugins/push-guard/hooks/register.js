// push-guard: refuses `git push` to a branch whose pull request is already merged.
//
// After a PR is merged, the branch is done: commits pushed there later never
// reach the base branch unless someone notices and opens a new PR. An agent
// that keeps working on a long-lived feature branch does exactly that and
// reports "pushed" - the work silently goes nowhere.
//
// On every Bash call that contains `git push`, the mod works out the target
// branch(es) and asks `gh` whether a merged PR with that head exists. If one
// does and no open PR uses the same head, the person is asked in the engine's
// own question dialog; only their "yes" lets the push run. No answer, a
// dismissed dialog or a run with nobody to ask (-p) is a refusal. There is
// deliberately no override the model could type itself (an env prefix, a
// flag): the guard exists because an agent in a hurry would use it.
// Anything it cannot check (no gh, not GitHub, offline) passes through.

const PROTECTED = /^(main|master|develop|dev|staging|production|release([/-].*)?)$/

// Shell-ish split: quotes respected, operators kept as their own tokens.
export function tokenize(cmd) {
  const out = []
  let cur = null          // the word being built; quotes glue onto it (VAR="a b")
  const end = () => { if (cur !== null) out.push(cur); cur = null }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < cmd.length && cmd[j] !== c) {
        if (c === '"' && cmd[j] === '\\' && j + 1 < cmd.length) j++
        s += cmd[j++]
      }
      cur = (cur ?? '') + s
      i = j
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur = (cur ?? '') + cmd[++i]
    } else if (/\s/.test(c) && c !== '\n') {
      end()
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      end()
      const two = cmd.slice(i, i + 2)
      if (two === '&&' || two === '||') i++
      out.push({ op: c })
    } else {
      cur = (cur ?? '') + c
    }
  }
  end()
  return out
}

// Every `git push` in the command: { dir, remote, refs, skip }.
// dir is relative to the session cwd unless absolute; `cd X &&` and `git -C X`
// are followed. skip is set for deletes, tags, mirrors and dry runs.
export function findPushes(cmd) {
  const segs = [[]]
  for (const t of tokenize(cmd)) {
    if (typeof t === 'object') segs.push([])
    else segs[segs.length - 1].push(t)
  }
  let dir = null
  const pushes = []
  for (let seg of segs) {
    while (seg.length && /^[A-Z_][A-Z0-9_]*=/.test(seg[0])) seg = seg.slice(1)   // VAR=x git push
    if (seg[0] === 'cd' && seg[1]) { dir = joinDir(dir, seg[1]); continue }
    if (seg[0] !== 'git') continue
    let i = 1
    let segDir = dir
    while (i < seg.length && seg[i].startsWith('-')) {
      if (seg[i] === '-C') { segDir = joinDir(segDir, seg[i + 1]); i += 2 }
      else if (seg[i] === '-c') i += 2
      else i += 1
    }
    if (seg[i] !== 'push') continue
    const args = seg.slice(i + 1)
    const flags = args.filter((a) => a.startsWith('-'))
    const pos = []
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      if (a === '-o' || a === '--push-option' || a === '--repo') { k++; continue }
      if (/^[0-9]*[<>]/.test(a)) { if (/^[0-9]*[<>]+$/.test(a)) k++; continue }   // 2>, >log, > log
      if (!a.startsWith('-')) pos.push(a)
    }
    const skip = flags.some((f) => /^(--delete|-d|--tags|--mirror|--dry-run|-n|--prune)$/.test(f))
    const [remote = 'origin', ...refs] = pos
    pushes.push({ dir: segDir, remote, refs, skip })
  }
  return pushes
}

function joinDir(base, d) {
  if (!d) return base
  if (d.startsWith('/') || d.startsWith('~')) return d
  return base ? `${base}/${d}` : d
}

// refspec -> destination branch name, or null for deletes and tags
export function destBranch(ref) {
  if (ref.startsWith(':') || ref.startsWith('refs/tags/')) return null
  let dst = ref.includes(':') ? ref.split(':')[1] : ref
  dst = dst.replace(/^\+/, '').replace(/^refs\/heads\//, '')
  return dst || null
}

async function run($, argv, cwd) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs: 15000 })
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' }
  }
}

async function resolveDir($, dir) {
  const cwd = await $.session.cwd()
  if (!dir) return cwd
  if (dir.startsWith('/')) return dir
  if (dir.startsWith('~')) {
    const home = await $.env.get('HOME')
    return (home || '') + dir.slice(1)
  }
  return `${cwd}/${dir}`
}

// The verdict for one branch: null = fine, otherwise the merged PR.
async function check($, cwd, branch) {
  if (PROTECTED.test(branch)) return null
  const r = await run($, ['gh', 'pr', 'list', '--head', branch, '--state', 'all',
    '--json', 'number,state,mergedAt,baseRefName', '--limit', '20'], cwd)
  if (r.exitCode !== 0) return null
  let prs
  try { prs = JSON.parse(r.stdout) } catch { return null }
  if (prs.some((p) => p.state === 'OPEN')) return null
  const merged = prs.filter((p) => p.state === 'MERGED')
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))[0]
  if (!merged) return null
  return merged
}

export const YES = 'Yes, push anyway'
export const NO = 'No, do not push'

function denyText(branch, pr, why) {
  const base = pr.baseRefName
  return `push-guard: branch '${branch}' was already merged into '${base}' (PR #${pr.number}, ` +
    `${String(pr.mergedAt).slice(0, 10)}); ${why}. Commits pushed there now would not reach '${base}'. ` +
    `Start a fresh branch from the current base instead, e.g.:\n` +
    `  git fetch origin && git switch -c ${branch}-2 origin/${base} && git cherry-pick <your commits>\n` +
    `then push that branch and open a new PR. Do not retry the push to '${branch}' in another way.`
}

export function register(on) {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' || typeof e.command !== 'string') return next(e)
    if (!/\bgit\b[^\n]*\bpush\b/.test(e.command)) return next(e)
    for (const p of findPushes(e.command)) {
      if (p.skip) continue
      const cwd = await resolveDir($, p.dir)
      let branches = p.refs.map(destBranch).filter(Boolean)
      if (!p.refs.length || branches.includes('HEAD')) {
        const r = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)
        const cur = r.exitCode === 0 ? r.stdout.trim() : ''
        branches = branches.filter((b) => b !== 'HEAD')
        if (cur && cur !== 'HEAD') branches.push(cur)
      }
      for (const b of branches) {
        const pr = await check($, cwd, b)
        if (!pr) continue
        let answer = ''
        try {
          answer = await $.ui.ask(
            `push-guard: '${b}' is already merged into '${pr.baseRefName}' (PR #${pr.number}). Push to it anyway?`,
            { header: 'push-guard', options: [NO, YES] })
        } catch {
          answer = ''
        }
        if (answer === YES) { $.ui.log(`push to merged branch '${b}' allowed by the user`); continue }
        $.ui.log(`push to merged branch '${b}' refused`)
        return { deny: denyText(b, pr, answer ? 'the user declined the push' : 'nobody confirmed the push') }
      }
    }
    return next(e)
  })
}

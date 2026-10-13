// agents-panel: who is working on this machine, and what waits on you.
//
// A band above the prompt shows every live Claude Code session as a little
// girl or boy (people.conf), coloured by model, grouped by project; a working
// session blinks an hourglass, one whose prompt cache has expired is dimmed.
// The last line counts the open checklist items that wait on the person.
// /team opens a pane with the details: model, idle time, cache, context, and
// the waiting items by project.
//
// A hooks module has no file system, so the data comes from `agents status
// --json --max-age N` (bin/agents in this repo), which caches its answer: all
// sessions running this mod together recompute it at most once per N seconds.

const POLL_MS = 5000
const MAX_AGE = 5

let data = null          // last answer of `agents status --json`
let error = ''
let frame = 0
let stopTick = null
let agentsBin = 'agents'

export const MODEL_COLORS = { haiku: '#3b82f6', sonnet: '#f59e0b', opus: '#a855f7', fable: '#22c55e' }

export function modelColor(model) {
  const m = String(model || '').toLowerCase()
  for (const k of Object.keys(MODEL_COLORS)) if (m.includes(k)) return MODEL_COLORS[k]
  return undefined
}

export function figure(gender) {
  return gender === 'f' ? '👧' : gender === 'm' ? '👦' : '🧒'
}

// one glyph for the session's state; busy blinks between two hourglasses
export function stateGlyph(s, tick) {
  if (s.status === 'busy') return tick % 2 ? '⌛' : '⏳'
  if (s.status === 'shell') return '⚙'
  if (s.status === 'idle') return s.cache_min !== null && s.cache_min <= 0 ? '💤' : '·'
  return '?'
}

export function shortModel(model) {
  const m = String(model || '').toLowerCase()
  return Object.keys(MODEL_COLORS).find((k) => m.includes(k)) || m || '?'
}

export function groupByProject(sessions) {
  const groups = new Map()
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, [])
    groups.get(s.project).push(s)
  }
  return [...groups.entries()]
}

export function hhmm(ts) {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function waitingLine(cl) {
  if (!cl) return 'checklist: no snapshot yet'
  return `waiting on you: ${cl.waiting.length} · open: ${cl.open} · snapshot ${hhmm(cl.snapshot)}`
}

async function refresh($) {
  let r
  try {
    r = await $.process.run([agentsBin, 'status', '--json', '--max-age', String(MAX_AGE)], { timeoutMs: 10000 })
  } catch (err) {
    r = { exitCode: 1, stdout: '', stderr: String(err?.message ?? err) }
  }
  if (r.exitCode !== 0 && agentsBin === 'agents') {
    const home = await $.env.get('HOME')
    if (home) { agentsBin = `${home}/.local/bin/agents`; return refresh($) }
  }
  if (r.exitCode !== 0) { error = (r.stderr || 'agents failed').split('\n')[0]; return }
  try { data = JSON.parse(r.stdout); error = '' } catch { error = 'agents: bad JSON' }
}

function Person({ s, Text }) {
  const dim = s.status === 'idle' && s.cache_min !== null && s.cache_min <= 0
  return (
    <Text color={modelColor(s.model)} dimColor={dim}>
      {`${figure(s.gender)}${s.display}${stateGlyph(s, frame)} `}
    </Text>
  )
}

function band(Box, Text, e) {
  if (!data) return <Text dimColor>{error ? `agents-panel: ${error}` : 'agents-panel: loading…'}</Text>
  const width = e.props?.bodyColumns || 80
  return (
    <Box flexDirection="column">
      {groupByProject(data.sessions).map(([project, list]) => (
        <Box key={`p-${project}`} flexDirection="row" flexWrap="wrap" width={width}>
          <Text dimColor>{`${project}: `}</Text>
          {list.map((s) => <Person key={`s-${s.pid}`} s={s} Text={Text} />)}
        </Box>
      ))}
      <Text dimColor>{`${waitingLine(data.checklist)} · /team`}</Text>
    </Box>
  )
}

function fmtDur(v) {
  if (v === null || v === undefined) return '—'
  return v >= 600 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`
}

function fmtMin(v) {
  if (v === null || v === undefined) return '—'
  if (v <= 0) return 'off'
  return v >= 600 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`
}

function teamPane(Box, Text) {
  if (!data) return <Text dimColor>{error || 'loading…'}</Text>
  const cl = data.checklist
  const waiting = cl ? groupByProject(cl.waiting.map((i) => ({ ...i, project: i.project || '?' }))) : []
  return (
    <Box flexDirection="column">
      {groupByProject(data.sessions).map(([project, list]) => (
        <Box key={`tp-${project}`} flexDirection="column" marginBottom={1}>
          <Text bold>{project}</Text>
          {list.map((s) => (
            <Box key={`ts-${s.pid}`} flexDirection="row">
              <Text color={modelColor(s.model)} wrap="truncate-end">
                {`${figure(s.gender)} ${s.display.slice(0, 11).padEnd(11)} ${shortModel(s.model).padEnd(6)}`}
              </Text>
              <Text dimColor={!(s.cache_min > 0)} wrap="truncate-end">
                {` ${stateGlyph(s, frame)} ${fmtDur(s.idle_min).padStart(5)} 💾${fmtMin(s.cache_min).padStart(4)} ${s.ctx ? `${Math.round(s.ctx / 1000)}k` : '—'}`}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      <Text bold>{waitingLine(cl)}</Text>
      {waiting.map(([project, items]) => (
        <Box key={`w-${project}`} flexDirection="column">
          <Text color="#f59e0b">{project}</Text>
          {items.map((i) => (
            <Text key={`wi-${i.id}`} wrap="truncate-end">{`  • ${i.title}  (${i.who})`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'team', description: 'All live agents on this machine and what waits on you' })
    await refresh($)
    if (stopTick) stopTick.cancel()
    stopTick = $.clock.every(POLL_MS, async () => {
      frame += 1
      await refresh($)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', { command: 'team' }, async ($) => {
    await refresh($)
    const r = await $.ui.open({ id: 'team', title: 'Team' })
    return r.isPlaced ? {} : { text: `team: ${r.reason || 'pane not placed'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return band(Box, Text, e)
  })

  on('ui.render', { component: 'Pane', requestId: 'team' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return teamPane(Box, Text)
  })
}

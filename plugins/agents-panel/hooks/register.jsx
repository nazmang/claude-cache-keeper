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

// --- pixel people -----------------------------------------------------------
// 10×12 pixels, drawn as 10 columns × 6 rows of half blocks (▀: top pixel is
// the foreground, bottom pixel the background). '.' is transparent.
// H hair, S skin, E eye, C clothes (the model's colour), D darker clothes.
export const SPRITES = {
  f: [
    '..HHHHHH..',
    '.HHHHHHHH.',
    'HHSSSSSSHH',
    'HHSESSESHH',
    'H.SSSSSS.H',
    'H..SSSS..H',
    '...CCCC...',
    '..CCCCCC..',
    '.CCCCCCCC.',
    'CCCCCCCCCC',
    '...S..S...',
    '..DD..DD..',
  ],
  m: [
    '..HHHHHH..',
    '..HHHHHH..',
    '..HSSSSH..',
    '..SESSES..',
    '..SSSSSS..',
    '...SSSS...',
    '..CCCCCC..',
    '.CCCCCCCC.',
    '.SCCCCCCS.',
    '..DDDDDD..',
    '..DD..DD..',
    '..DD..DD..',
  ],
  '-': [
    '...DDDD...',
    '..DDDDDD..',
    '..SSSSSS..',
    '..SESSES..',
    '..SSSSSS..',
    '...SSSS...',
    '..CCCCCC..',
    '.CCCCCCCC.',
    '.SCCCCCCS.',
    '..CCCCCC..',
    '..DD..DD..',
    '..DD..DD..',
  ],
}

// girls ginger, boys chestnut: both must read on a dark card background
const HAIR = { f: 0xd2733a, m: 0xa86a3c, '-': 0xa86a3c }

const DEFAULT = 0x01000000
const hex = (c) => parseInt(c.slice(1), 16)
function darker(c, k = 0.7) {
  const n = hex(c)
  const ch = (sh) => Math.round(((n >> sh) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// pixel rows (12) -> Raster cells: base64 of [codePoint, fg, bg] u32 triplets
export function spriteCells(gender, color, { lift = false, dim = false } = {}) {
  const rows = SPRITES[gender] || SPRITES['-']
  const pix = lift ? [...rows.slice(1), '..........'] : rows   // busy: hop one pixel
  const body = color ? hex(color) : 0x8a9a9c
  const pal = {
    H: HAIR[gender] ?? HAIR['-'], S: 0xf1c7a1, E: 0x111111,
    C: body, D: color ? darker(color) : 0x5f6d6f,
  }
  const fade = (c) => (dim && c !== DEFAULT ? darker('#' + c.toString(16).padStart(6, '0'), 0.6) : c)
  const at = (r, c) => { const ch = (pix[r] || '')[c]; return ch && ch !== '.' ? fade(pal[ch]) : DEFAULT }
  const words = []
  for (let r = 0; r < 12; r += 2) {
    for (let c = 0; c < 10; c++) {
      const top = at(r, c), bottom = at(r + 1, c)
      if (top === DEFAULT && bottom === DEFAULT) words.push(0x20, DEFAULT, DEFAULT)
      else if (top === DEFAULT) words.push(0x2584, bottom, DEFAULT)        // ▄
      else words.push(0x2580, top, bottom)                                 // ▀
    }
  }
  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

// what the agent is doing, as one glyph above its head
export function activityIcon(s) {
  if (s.status === 'idle') return s.cache_min !== null && s.cache_min <= 0 ? '💤' : '☕'
  if (s.status === 'shell') return '⚙️'
  if (s.status !== 'busy') return '❔'
  const t = String(s.tool || '')
  if (/^(Read|NotebookRead)$/.test(t)) return '📖'
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(t)) return '✏️'
  if (/^(Bash|PowerShell|Monitor)$/.test(t)) return '⚡'
  if (/^(Grep|Glob|ToolSearch|WebSearch|WebFetch)$/.test(t)) return '🔍'
  if (/^(Agent|Task|Workflow)$/.test(t)) return '👥'
  if (/^(SendMessage|ListAgents|ReadNotifications)$/.test(t)) return '💬'
  if (/^mcp__/.test(t)) return '🔌'
  return t ? '🛠️' : '🧠'
}

export function headline(sessions) {
  const busy = sessions.filter((s) => s.status === 'busy').length
  const asleep = sessions.filter((s) => s.status === 'idle' && s.cache_min !== null && s.cache_min <= 0).length
  return `${busy} working · ${sessions.length - busy - asleep} waiting · ${asleep} asleep`
}

function fmtMin(v) {
  if (v === null || v === undefined) return '—'
  if (v <= 0) return 'off'
  return v >= 600 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`
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
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    if (!data) return <Text dimColor>{error || 'loading…'}</Text>
    const cl = data.checklist
    const waiting = cl ? groupByProject(cl.waiting.map((i) => ({ ...i, project: i.project || '?' }))) : []
    let n = 0
    // a press jumps to the agent's tmux window; a session outside tmux has none
    const jump = (s) => async () => {
      if (!s.target) { $.ui.toast(`${s.display}: not in tmux`); return }
      const r = await $.process.run(['tmux', 'switch-client', '-t', s.target], { timeoutMs: 5000 })
      if (r.exitCode !== 0) $.ui.toast(`${s.display}: ${(r.stderr || 'tmux failed').split('\n')[0]}`)
    }
    const card = (s) => {
      n += 1
      const busy = s.status === 'busy'
      const asleep = s.status === 'idle' && s.cache_min !== null && s.cache_min <= 0
      const pic = Raster
        ? <Raster key={`r-${s.pid}`} columns={10} rows={6}
            cells={spriteCells(s.gender, modelColor(s.model), { lift: busy && frame % 2 === 1, dim: asleep })} />
        : <Text color={modelColor(s.model)}>{figure(s.gender)}</Text>
      // a Button holds text only: picture above, the clickable name under it
      return (
        <Box key={`a-${s.pid}`} flexDirection="column" alignItems="center" width={14}>
          <Text>{activityIcon(s)}</Text>
          {pic}
          <Button key={`b-${s.pid}`} label={s.display.slice(0, 10)}
            hotkey={n <= 9 ? String(n) : undefined} plain onPress={jump(s)}>
            <Text color={modelColor(s.model)} bold={busy}>{s.display.slice(0, 10)}</Text>
          </Button>
          <Text dimColor wrap="truncate-end">{`${shortModel(s.model)} ${fmtMin(s.cache_min)}`}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{headline(data.sessions)}</Text>
        {groupByProject(data.sessions).map(([project, list]) => (
          <Box key={`tp-${project}`} flexDirection="column" marginTop={1}>
            <Text dimColor>{project}</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{list.map(card)}</Box>
          </Box>
        ))}
        <Box marginTop={1} flexDirection="column">
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
      </Box>
    )
  })
}

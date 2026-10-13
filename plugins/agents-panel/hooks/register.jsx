// agents-panel: who is working on this machine, and what waits on you.
//
// A one-line band above the prompt: who is working right now, how many are
// asleep (cache gone), the latest message between sessions and how many
// checklist items wait on the person. /team opens the full pane: every live
// session as a pixel girl or boy (people.conf) in the model's colour, what
// each is doing, clickable to jump to its tmux window, the messages and the
// waiting items. A session started with AGENTS_PANEL_OPEN=1 in its settings
// env opens /team by itself - a dedicated dashboard window. People marked
// `x` in people.conf (such a dashboard) are left out.
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
let expanded = ''        // the project opened in the checklist tab

// --- language ---------------------------------------------------------------
// AGENTS_LANG (ru|en) wins; otherwise the first non-empty of LC_ALL,
// LC_MESSAGES, LANG: "ru..." is Russian, anything else English. Picked once,
// when the session starts. `agents status --json` stays language-neutral.
let LANG = 'en'
export function setLang(l) { LANG = l === 'ru' ? 'ru' : 'en' }

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
    cmd_team: 'Open or close the panel: every live agent on this machine and what waits on you',
    cmd_checklist: 'Open or close the checklist tab: open items by project, yours first',
    tab_team: 'Team',
    tab_checklist: 'Checklist',
    not_placed: '{id}: {why}',
    pane_not_placed: 'pane not placed',
    loading: 'loading…',
    band_loading: 'agents-panel: loading…',
    band_error: 'agents-panel: {err}',
    agents_failed: 'agents failed',
    bad_json: 'agents: bad JSON',
    nobody: 'nobody',
    band_idle: '{n} idle ({a} 💤)',
    band_waiting: 'waiting on you: {n}',
    cold_wake: ' woke a cold cache',
    no_snapshot: 'checklist: no snapshot yet',
    waiting_line: 'waiting on you: {w} · open: {o} · snapshot {at}',
    headline: '{b} working · {w} waiting · {a} asleep',
    off: 'off',
    h: 'h',
    m: 'm',
    open_n: '{n} open',
    you_n: ' · {n} you',
    later_n: ' · {n} later',
    cl_head: '{o} open · {w} waiting on you · snapshot {at}',
    cl_readonly: 'edit on the checklist page or ask an agent; this tab is read-only',
    cl_none: 'no checklist snapshot yet',
    not_in_tmux: '{name}: not in tmux',
    tmux_failed: 'tmux failed',
    messages: 'Messages, last 6 h ({n} woke a cold cache)',
  },
  ru: {
    cmd_team: 'Открыть или закрыть панель: все живые агенты на этой машине и что ждёт тебя',
    cmd_checklist: 'Открыть или закрыть вкладку чек-листа: открытые пункты по проектам, твои сверху',
    tab_team: 'Команда',
    tab_checklist: 'Чек-лист',
    not_placed: '{id}: {why}',
    pane_not_placed: 'панель не встала',
    loading: 'загрузка…',
    band_loading: 'agents-panel: загрузка…',
    band_error: 'agents-panel: {err}',
    agents_failed: 'agents не отработал',
    bad_json: 'agents: кривой JSON',
    nobody: 'никого',
    band_idle: '{n} ждут ({a} 💤)',
    band_waiting: 'ждут тебя: {n}',
    cold_wake: ' разбудил остывший кэш',
    no_snapshot: 'чек-лист: снимка пока нет',
    waiting_line: 'ждут тебя: {w} · открыто: {o} · снимок {at}',
    headline: '{b} работают · {w} ждут · {a} спят',
    off: 'нет',
    h: 'ч',
    m: 'м',
    open_n: '{n} открыто',
    you_n: ' · {n} тебе',
    later_n: ' · {n} на потом',
    cl_head: '{o} открыто · {w} ждут тебя · снимок {at}',
    cl_readonly: 'правь на странице чек-листа или попроси агента; вкладка только для чтения',
    cl_none: 'снимка чек-листа пока нет',
    not_in_tmux: '{name}: не в tmux',
    tmux_failed: 'tmux не сработал',
    messages: 'Сообщения за 6 ч ({n} разбудили остывший кэш)',
  },
}

export function t(key, vars = {}) {
  const tpl = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}

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

export function messageLine(m) {
  if (!m) return ''
  return `📨 ${hhmm(m.ts)} ${m.from} → ${m.to}${m.cold ? ` ❄${t('cold_wake')}` : ''}: ${m.text}`
}

export function waitingLine(cl) {
  if (!cl) return t('no_snapshot')
  return t('waiting_line', { w: cl.waiting.length, o: cl.open, at: hhmm(cl.snapshot) })
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
  if (r.exitCode !== 0) { error = (r.stderr || t('agents_failed')).split('\n')[0]; return }
  try { data = JSON.parse(r.stdout); error = '' } catch { error = t('bad_json') }
}

export function bandLine(sessions, frameNo) {
  const busy = sessions.filter((s) => s.status === 'busy')
  const asleep = sessions.filter((s) => s.status === 'idle' && s.cache_min !== null && s.cache_min <= 0).length
  const who = busy.length
    ? busy.map((s) => `${figure(s.gender)}${s.display}`).join(' ')
    : t('nobody')
  return `${frameNo % 2 ? '⌛' : '⏳'} ${who} · ${t('band_idle', { n: sessions.length - busy.length, a: asleep })}`
}

function band(Box, Text, e) {
  if (!data) return <Text dimColor>{error ? t('band_error', { err: error }) : t('band_loading')}</Text>
  const people = visible(data.sessions)
  const m = data.messages && data.messages[0]
  const parts = [bandLine(people, frame)]
  if (m) parts.push(`📨 ${hhmm(m.ts)} ${m.from}→${m.to}${m.cold ? ' ❄' : ''}`)
  if (data.checklist) parts.push(t('band_waiting', { n: data.checklist.waiting.length }))
  parts.push('/team')
  return <Text dimColor wrap="truncate-end">{parts.join(' · ')}</Text>
}

export function visible(sessions) {
  return (sessions || []).filter((s) => s.gender !== 'x')
}

function fmtDur(v) {
  if (v === null || v === undefined) return '—'
  return v >= 600 ? `${Math.round(v / 60)}${t('h')}` : `${Math.round(v)}${t('m')}`
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
  return t('headline', { b: busy, w: sessions.length - busy - asleep, a: asleep })
}

function fmtMin(v) {
  if (v === null || v === undefined) return '—'
  if (v <= 0) return t('off')
  return v >= 600 ? `${Math.round(v / 60)}${t('h')}` : `${Math.round(v)}${t('m')}`
}

// open items of one project: those waiting on the person first
export function projectItems(cl, name) {
  const list = ((cl && cl.items) || []).filter((i) => (i.project || '?') === name)
  const mine = new Set(((cl && cl.waiting) || []).map((i) => i.id))
  return [...list.filter((i) => mine.has(i.id)), ...list.filter((i) => !mine.has(i.id))]
    .map((i) => ({ ...i, mine: mine.has(i.id) }))
}

export function projectLabel(p) {
  const you = p.waiting ? t('you_n', { n: p.waiting }) : ''
  return `${p.name}  ${t('open_n', { n: p.todo })}${you}${p.later ? t('later_n', { n: p.later }) : ''}`
}

async function togglePane($, id, title) {
  const open = (await $.ui.panes()).some((p) => p.id === id)
  if (open) { await $.ui.close({ id }); return {} }
  await refresh($)
  const r = await $.ui.open({ id, title })
  return r.isPlaced ? {} : { text: t('not_placed', { id, why: r.reason || t('pane_not_placed') }) }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    LANG = await pickLang($)
    await $.command.register({ name: 'team', description: t('cmd_team') })
    await $.command.register({ name: 'checklist', description: t('cmd_checklist') })
    await refresh($)
    if ((await $.env.get('AGENTS_PANEL_OPEN')) === '1') {
      try {
        await $.ui.open({ id: 'checklist', title: t('tab_checklist') })
        await $.ui.open({ id: 'team', title: t('tab_team') })
      } catch {}
    }
    if (stopTick) stopTick.cancel()
    stopTick = $.clock.every(POLL_MS, async () => {
      frame += 1
      await refresh($)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // /team and /checklist toggle their tabs
  on('command.run', { command: 'team' }, async ($) => togglePane($, 'team', t('tab_team')))
  on('command.run', { command: 'checklist' }, async ($) => togglePane($, 'checklist', t('tab_checklist')))

  on('ui.render', { component: 'Pane', requestId: 'checklist' }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cl = data && data.checklist
    if (!cl) return <Text dimColor>{error || t('cl_none')}</Text>
    const open = (name) => () => { expanded = expanded === name ? '' : name; $.ui.invalidate('ui.render') }
    return (
      <Box flexDirection="column">
        <Text bold>{t('cl_head', { o: cl.open, w: cl.waiting.length, at: hhmm(cl.snapshot) })}</Text>
        <Text dimColor>{t('cl_readonly')}</Text>
        {(cl.projects || []).filter((p) => p.todo || p.later).map((p) => (
          <Box key={`p-${p.name}`} flexDirection="column" marginTop={1}>
            <Button key={`pb-${p.name}`} label={projectLabel(p)} plain onPress={open(p.name)}>
              <Text bold={expanded === p.name} color={p.waiting ? '#f59e0b' : undefined}>
                {`${expanded === p.name ? '▾' : '▸'} ${projectLabel(p)}`}
              </Text>
            </Button>
            {expanded === p.name ? projectItems(cl, p.name).map((i) => (
              <Text key={`i-${i.id}`} wrap="truncate-end" color={i.mine ? '#f59e0b' : undefined}>
                {`   ${i.mine ? '★' : '·'} ${i.title}${i.who ? `  (${i.who})` : ''}`}
              </Text>
            )) : null}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return band(Box, Text, e)
  })

  on('ui.render', { component: 'Pane', requestId: 'team' }, ($, e) => {
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    if (!data) return <Text dimColor>{error || t('loading')}</Text>
    const people = visible(data.sessions)
    const cl = data.checklist
    const waiting = cl ? groupByProject(cl.waiting.map((i) => ({ ...i, project: i.project || '?' }))) : []
    let n = 0
    // a press jumps to the agent's tmux window; a session outside tmux has none
    const jump = (s) => async () => {
      if (!s.target) { $.ui.toast(t('not_in_tmux', { name: s.display })); return }
      const r = await $.process.run(['tmux', 'switch-client', '-t', s.target], { timeoutMs: 5000 })
      if (r.exitCode !== 0) $.ui.toast(`${s.display}: ${(r.stderr || t('tmux_failed')).split('\n')[0]}`)
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
        <Text bold>{headline(people)}</Text>
        {groupByProject(people).map(([project, list]) => (
          <Box key={`tp-${project}`} flexDirection="column" marginTop={1}>
            <Text dimColor>{project}</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{list.map(card)}</Box>
          </Box>
        ))}
        {data.messages && data.messages.length ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>{t('messages', { n: data.messages.filter((m) => m.cold).length })}</Text>
            {data.messages.slice(0, 8).map((m, i) => (
              <Text key={`m-${i}`} wrap="truncate-end" color={m.cold ? '#38bdf8' : undefined}>
                {`${hhmm(m.ts)} ${m.cold ? '❄' : ' '} ${m.from} → ${m.to}: ${m.text}`}
              </Text>
            ))}
          </Box>
        ) : null}
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

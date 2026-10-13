import { expect, mock, test } from 'claude-code/testing'
import { setLang, projectItems, projectLabel, bandLine, visible, messageLine, activityIcon, figure, groupByProject, headline, modelColor, shortModel, SPRITES, spriteCells, stateGlyph, waitingLine } from '../hooks/register.jsx'

test('girls, boys and the rest', async () => {
  expect(figure('f')).toBe('👧')
  expect(figure('m')).toBe('👦')
  expect(figure('-')).toBe('🧒')
})

test('model colours and short names', async () => {
  expect(modelColor('opus-5-5')).toBe('#a855f7')
  expect(modelColor('sonnet')).toBe('#f59e0b')
  expect(modelColor('mystery')).toBeUndefined()
  expect(shortModel('fable-5-1')).toBe('fable')
})

test('state glyphs: busy blinks, expired cache sleeps', async () => {
  expect(stateGlyph({ status: 'busy', cache_min: 50 }, 0)).toBe('⏳')
  expect(stateGlyph({ status: 'busy', cache_min: 50 }, 1)).toBe('⌛')
  expect(stateGlyph({ status: 'idle', cache_min: 20 }, 0)).toBe('·')
  expect(stateGlyph({ status: 'idle', cache_min: -5 }, 0)).toBe('💤')
})

test('groups keep first-seen project order', async () => {
  const g = groupByProject([{ project: 'b' }, { project: 'a' }, { project: 'b' }] as never[])
  expect(g.map(([p, l]) => `${p}:${l.length}`)).toEqual(['b:2', 'a:1'])
})

test('waiting line', async () => {
  expect(waitingLine(null)).toMatch(/no snapshot/)
  expect(waitingLine({ waiting: [1, 2], open: 9, snapshot: 0 } as never)).toMatch(/waiting on you: 2 · open: 9/)
})

test('sprites are 10×12 and pack into 60 cells', async () => {
  for (const g of ['f', 'm', '-']) {
    expect(SPRITES[g].length).toBe(12)
    for (const row of SPRITES[g]) expect(row.length).toBe(10)
    const bytes = Uint8Array.fromBase64(spriteCells(g, '#a855f7'))
    expect(bytes.length).toBe(60 * 3 * 4)
  }
})

test('activity icons and headline', async () => {
  expect(activityIcon({ status: 'busy', tool: 'Read' })).toBe('📖')
  expect(activityIcon({ status: 'busy', tool: 'Bash' })).toBe('⚡')
  expect(activityIcon({ status: 'busy', tool: '' })).toBe('🧠')
  expect(activityIcon({ status: 'idle', cache_min: -3 })).toBe('💤')
  expect(headline([{ status: 'busy' }, { status: 'idle', cache_min: 20 }, { status: 'idle', cache_min: -1 }] as never[]))
    .toBe('1 working · 1 waiting · 1 asleep')
})

test('message line marks cold wakes', async () => {
  expect(messageLine(undefined)).toBe('')
  expect(messageLine({ ts: 0, from: 'Alina', to: 'Rita', text: 'go', cold: true } as never)).toMatch(/Alina → Rita ❄ woke a cold cache: go/)
  expect(messageLine({ ts: 0, from: 'A', to: 'B', text: 'x', cold: false } as never)).not.toMatch(/❄/)
})

test('band is one short line; dashboards are hidden', async () => {
  const ss = [
    { display: 'Rita', gender: 'f', status: 'busy', cache_min: 50 },
    { display: 'Gleb', gender: 'm', status: 'idle', cache_min: -3 },
    { display: 'Panel', gender: 'x', status: 'idle', cache_min: 40 },
  ] as never[]
  expect(visible(ss).length).toBe(2)
  expect(bandLine(visible(ss), 0)).toBe('⏳ 👧Rita · 1 idle (1 💤)')
})

test('checklist tab: yours first, label with counts', async () => {
  const cl = { items: [{ id: 'a', project: 'P', title: 'x' }, { id: 'b', project: 'P', title: 'y' }, { id: 'c', project: 'Q', title: 'z' }],
    waiting: [{ id: 'b' }] } as never
  expect(projectItems(cl, 'P').map((i) => `${i.id}${i.mine ? '*' : ''}`)).toEqual(['b*', 'a'])
  expect(projectLabel({ name: 'P', todo: 2, later: 1, done: 5, waiting: 1 } as never)).toBe('P  2 open · 1 you · 1 later')
})

// --- language and surfaces ---------------------------------------------------
const DATA = {
  at: '2026-10-13T10:00:00+00:00',
  sessions: [
    { name: 'a', display: 'Rita', gender: 'f', project: 'P', status: 'busy', model: 'opus-5', idle_min: 1, cache_min: 59, ctx: 90000, tmux: 'P:a', target: '=P:0', pid: 1, tool: 'Read' },
    { name: 'b', display: 'Gleb', gender: 'm', project: 'P', status: 'idle', model: 'sonnet-5', idle_min: 70, cache_min: -10, ctx: 0, tmux: null, target: null, pid: 2, tool: '' },
  ],
  checklist: { snapshot: 0, open: 3, waiting: [{ id: 'x', project: 'P', title: 't', who: 'you' }],
    items: [{ id: 'x', project: 'P', title: 't', who: 'you' }],
    projects: [{ name: 'P', todo: 3, later: 1, done: 0, waiting: 1 }] },
  messages: [{ ts: 0, from: 'Rita', to: 'Gleb', text: 'hi', cold: true }],
}

function setupUi(on, env: Record<string, string>) {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u', ...env })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(DATA), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const PROPS = { band: { component: 'AbovePrompt', props: {} }, team: { component: 'Pane', requestId: 'team', props: { title: 'Team', focused: false } },
  checklist: { component: 'Pane', requestId: 'checklist', props: { title: 'Checklist', focused: false } } }

test('band, /team and /checklist draw in English', async ($, on) => {
  setupUi(on, { LANG: 'en_US.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'agents-panel', surface, ...PROPS.band } as never)
    expect(await band.find({ type: 'Text', text: /waiting on you: 1/ })).toBeDefined()
    await band.unmount()
    const team = await $.ui.mount({ plugin: 'agents-panel', surface, ...PROPS.team } as never)
    expect(await team.find({ type: 'Text', text: /1 working · 0 waiting · 1 asleep/ })).toBeDefined()
    await team.unmount()
    const cl = await $.ui.mount({ plugin: 'agents-panel', surface, ...PROPS.checklist } as never)
    expect(await cl.find({ type: 'Text', text: /3 open · 1 waiting on you/ })).toBeDefined()
    await cl.unmount()
  }
})

test('the same under a Russian locale', async ($, on) => {
  setupUi(on, { LANG: 'ru_RU.UTF-8' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'agents-panel', surface, ...PROPS.band } as never)
    expect(await band.find({ type: 'Text', text: /ждут тебя: 1/ })).toBeDefined()
    await band.unmount()
    const team = await $.ui.mount({ plugin: 'agents-panel', surface, ...PROPS.team } as never)
    expect(await team.find({ type: 'Text', text: /1 работают · 0 ждут · 1 спят/ })).toBeDefined()
        await team.unmount()
  }
})

test('pure helpers speak Russian after setLang', async () => {
  setLang('ru')
  try {
    expect(waitingLine(null)).toMatch(/снимка пока нет/)
    expect(headline([{ status: 'busy' }] as never[])).toBe('1 работают · 0 ждут · 0 спят')
    expect(projectLabel({ name: 'P', todo: 2, later: 1, done: 5, waiting: 1 } as never)).toBe('P  2 открыто · 1 тебе · 1 на потом')
    expect(bandLine([{ display: 'Rita', gender: 'f', status: 'idle', cache_min: -1 }] as never[], 0)).toBe('⏳ никого · 1 ждут (1 💤)')
  } finally { setLang('en') }
})

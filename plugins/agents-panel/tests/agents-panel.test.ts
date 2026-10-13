import { expect, test } from 'claude-code/testing'
import { projectItems, projectLabel, bandLine, visible, messageLine, activityIcon, figure, groupByProject, headline, modelColor, shortModel, SPRITES, spriteCells, stateGlyph, waitingLine } from '../hooks/register.jsx'

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

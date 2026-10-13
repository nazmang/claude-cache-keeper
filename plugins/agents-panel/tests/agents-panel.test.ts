import { expect, test } from 'claude-code/testing'
import { activityIcon, figure, groupByProject, headline, modelColor, shortModel, SPRITES, spriteCells, stateGlyph, waitingLine } from '../hooks/register.jsx'

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

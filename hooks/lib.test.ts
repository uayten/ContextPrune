import { expect, test } from 'claude-code/testing'

import type { SessionMessage } from 'claude-code'

import {
  cacheState,
  dataPathFor,
  formatTokens,
  markedTurns,
  matchMarks,
  applyToolMarks,
  toolListing,
  liveSlice,
  anchorOf,
  endsWithAnchor,
  modelNote,
  parseRecords,
  removedTokens,
  rewrittenTokens,
  shouldAutoPrune,
  stripImages,
  hasImage,
  countImages,
  describeRow,
  boundaryOf,
  measureTurn,
  recordTurn,
  withMeasured,
  apiEstimates,
  withEstimates,
  normalizeImages,
  imageTokens,
  placeImages,
  pruneDescription,
  pruneMessages,
  splitTurns,
  statusLabel,
  updateRecord,
} from './lib'

const MIN = 60_000

test('tokens read short', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(1600)).toBe('1.6k')
  expect(formatTokens(9_960)).toBe('10k')
  expect(formatTokens(45_400)).toBe('45k')
  expect(formatTokens(200_000)).toBe('200k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

test('cache counts down from the last request and then goes cold', () => {
  expect(cacheState(null, 0)).toBe(null)
  expect(cacheState(0, 0)).toEqual({ isWarm: true, minutesLeft: 60 })
  expect(cacheState(0, 18 * MIN + 1)).toEqual({ isWarm: true, minutesLeft: 42 })
  expect(cacheState(0, 60 * MIN)).toEqual({ isWarm: false })
})

test('model note carries the numbers', () => {
  const meter = { tokens: 45_000, window: 200_000, lastRequestAt: 0 }
  expect(modelNote(meter)).toBe('context-prune: context 45k / 200k (23%) tokens.')
  expect(modelNote({ window: 200_000, lastRequestAt: null })).toBe(undefined)
  expect(modelNote({ ...meter, isEstimate: true })).toBe('context-prune: context ~45k / 200k (23%) tokens.')
})

test('records merge per session and drop month-old ones', () => {
  const now = 100 * 24 * 60 * MIN
  const old = { lastRequestAt: now - 31 * 24 * 60 * MIN }
  const live = { lastRequestAt: now - 60 * MIN }
  expect(updateRecord({ old, live }, 'live', { lastRequestAt: now }, now)).toEqual({
    live: { lastRequestAt: now },
  })
  expect(updateRecord({}, 'a', { lastRequestAt: now }, now)).toEqual({ a: { lastRequestAt: now } })
})

test('data file sits under ~/.claude, outside the plugin folder', () => {
  expect(dataPathFor({ home: 'C:\\Users\\me' })).toBe('C:/Users/me/.claude/plugins/data/context-prune/sessions.json')
  expect(dataPathFor({ home: '/home/me' })).toBe('/home/me/.claude/plugins/data/context-prune/sessions.json')
  expect(dataPathFor({ configDir: '/cfg/', home: '/home/me' })).toBe('/cfg/plugins/data/context-prune/sessions.json')
  expect(dataPathFor({})).toBe(undefined)
})

test('a missing or broken data file reads as empty', () => {
  expect(parseRecords(undefined)).toEqual({})
  expect(parseRecords('not json')).toEqual({})
  expect(parseRecords('[1]')).toEqual({})
  expect(parseRecords('{"a":5,"b":{"lastRequestAt":5}}')).toEqual({ b: { lastRequestAt: 5 } })
})

test('status reads warm with minutes left, or cold with /prune', () => {
  expect(statusLabel(null)).toBe(undefined)
  expect(statusLabel({ isWarm: true, minutesLeft: 58 })).toBe('Conversa está quente - 58 min restantes')
  expect(statusLabel({ isWarm: false })).toBe('Conversa está fria - /prune recomendado')
})

const prompt = (text: string, handle?: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })
const reply = (text: string, handle?: string): SessionMessage => ({ role: 'assistant', text, toolUses: [], handle })
const call = (id: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' } }],
})
const result = (id: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text: 'a.txt', isError: false }],
})

// 0 first prompt, 2 second (with a tool call), 6 a command, 7 third.
const talk: SessionMessage[] = [
  prompt('<system-reminder>\nrules\n</system-reminder>\nfirst', 'u0'),
  reply('one'),
  prompt('second', 'u2'),
  call('t1'),
  result('t1'),
  reply('two'),
  prompt('<command-name>/prune</command-name>'),
  prompt('third', 'u7'),
  reply('three'),
  prompt(''),
]

test('turns run from a prompt to the next, tool results inside', () => {
  const turns = splitTurns(talk)
  expect(turns.map(t => [t.index, t.end])).toEqual([[0, 2], [2, 6], [6, 7], [7, 9], [9, 10]])
  expect(turns.map(t => t.preview)).toEqual(['first', 'second', '<command-name>/prune</command-name>', 'third', '[imagem anexada]'])
  expect(turns.map(t => t.isCommand)).toEqual([false, false, true, false, false])
})

test('marks find turns by uuid, or by position while the text still matches', () => {
  const byUuid = markedTurns(talk, [{ uuid: 'u2' }, { uuid: 'gone' }])
  expect(byUuid.map(t => t.index)).toEqual([2])
  const byIndex = markedTurns(talk, [{ index: 7, head: 'third' }, { index: 2, head: 'moved' }])
  expect(byIndex.map(t => t.index)).toEqual([7])
})

test('a mark survives old rows ahead of the list, and one with no turn is reported', () => {
  // As marked on a list with the replaced rows still ahead of the live ones.
  const shown = [prompt('second'), reply('old'), ...talk]
  const mark = { index: 4, head: 'second', fromEnd: shown.length - 4 }
  const { cut, missed } = matchMarks(talk, [mark, { index: 0, head: 'gone' }])
  expect(cut.map(t => t.index)).toEqual([2])
  expect(missed).toEqual([{ index: 0, head: 'gone' }])
})

test('a cut turn goes whole, its tool call and result with it', () => {
  const cut = markedTurns(talk, [{ index: 2, head: 'second' }])
  const out = pruneMessages(talk, cut, 'the ls run')
  expect(out.map(m => m.text)).toEqual([talk[0].text, 'one', '[removido: 1 turno (pedidos do usuário e respostas do Claude): the ls run]', talk[6].text, 'third', 'three', ''])
  expect(out.some(m => m.toolUses.length || m.toolResults?.length)).toBe(false)
  expect(out[0]).toBe(talk[0])
})

test('neighbouring cuts share one line; the first keeps its reminders', () => {
  const cut = splitTurns(talk).filter(t => t.index === 0 || t.index === 2)
  const out = pruneMessages(talk, cut, '')
  expect(out[0]).toEqual({
    role: 'user',
    text: '<system-reminder>\nrules\n</system-reminder>\n[removido: 2 turnos (pedidos do usuário e respostas do Claude): first | second]',
    toolUses: [],
  })
  expect(out.length).toBe(5)
})

test('marked tokens add up; auto prune only on a cold cache', () => {
  const turns = splitTurns(talk)
  expect(removedTokens([turns[1], turns[3]])).toBe(turns[1].tokens + turns[3].tokens)
  expect(rewrittenTokens(turns, [turns[1], turns[3]])).toBe(turns[2].tokens + turns[4].tokens)
  expect(rewrittenTokens(turns, [])).toBe(0)
  expect(shouldAutoPrune(true, { isWarm: false })).toBe(true)
  expect(shouldAutoPrune(true, { isWarm: true, minutesLeft: 3 })).toBe(false)
  expect(shouldAutoPrune(true, null)).toBe(false)
  expect(shouldAutoPrune(false, { isWarm: false })).toBe(false)
})

test('only the compaction /prune starts carries the tag', () => {
  expect(pruneDescription(undefined)).toBe(undefined)
  expect(pruneDescription('keep the plan')).toBe(undefined)
  expect(pruneDescription('context-prune:prune')).toBe('')
  expect(pruneDescription('context-prune:prune  the ls run ')).toBe('the ls run')
})

test('images are found at the top and inside tool results', () => {
  expect(hasImage([{ type: 'text', text: 'hi' }])).toBe(false)
  expect(hasImage([{ type: 'image', source: {} }, { type: 'text', text: 'hi' }])).toBe(true)
  expect(hasImage([{ type: 'tool_result', tool_use_id: 't', content: 'plain' }])).toBe(false)
  expect(hasImage([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image' }] }])).toBe(true)
})

test('rows with images lose the handle (and so the image), keep text and tool blocks', () => {
  const rows = [prompt('look', 'p1'), reply('ok', 'a1'), prompt('', 'p2'), { ...result('t1'), handle: 'r1' }]
  const out = stripImages(rows, new Set(['p1', 'p2', 'r1']))
  expect(out[0]).toEqual({ role: 'user', text: 'look\n[print removido]', toolUses: [] })
  expect(out[1]).toBe(rows[1])
  expect(out[2].text).toBe('[print removido]')
  expect(out[3].toolResults).toEqual(rows[3].toolResults)
  expect(out[3].handle).toBe(undefined)
  expect(countImages(rows, new Set(['p1', 'gone']))).toBe(1)
})

test('the pane preview leaves out a removed print, the model text keeps it', () => {
  const turns = splitTurns([prompt('look at this\n[print removido]'), reply('ok'), prompt('[print removido]'), reply('ok')])
  expect(turns.map(t => t.preview)).toEqual(['look at this', '[imagem anexada]'])
  expect(turns[0].head).toBe('look at this\n[print removido]')
})

test('the live conversation is found past the rows a compaction replaced', () => {
  const live = [prompt('open'), reply('a'), prompt('later'), reply('b')]
  const anchor = anchorOf(live.slice(0, 3))
  const old = [prompt('open'), reply('x'), prompt('gone'), reply('y')]
  expect(liveSlice([...old, ...live], anchor)).toEqual(live)
  expect(liveSlice(live, anchor)).toEqual(live)
  expect(liveSlice(live, null)).toEqual(live)
  expect(liveSlice(live, { head: 'other', count: 1 })).toEqual(live)
  // Mid-compaction: the old rows and only the first new one.
  expect(endsWithAnchor([...old, live[0]], anchorOf(live))).toBe(false)
  expect(endsWithAnchor([...old, ...live], anchorOf(live))).toBe(true)
  expect(endsWithAnchor(old, null)).toBe(true)
})

test('commands between marked turns go with them, into one line', () => {
  const marks = [{ index: 2, head: 'second' }, { index: 7, head: 'third' }]
  const { cut } = matchMarks(talk, marks)
  expect(cut.map(t => t.index)).toEqual([2, 6, 7])
  const out = pruneMessages(talk, cut, '')
  expect(out.map(m => m.text)).toEqual([talk[0].text, 'one', '[removido: 2 turnos (pedidos do usuário e respostas do Claude): second | third]', ''])
  // A command next to one mark only stays.
  expect(matchMarks(talk, [marks[0]]).cut.map(t => t.index)).toEqual([2])
})

test('pruning a removed line again adds up its turns instead of nesting', () => {
  const rows = [prompt('[removido: 3 turnos (pedidos do usuário e respostas do Claude): a | b | c]'), reply('x'), prompt('d'), reply('y'), prompt('[removido: e | f]'), prompt('now')]
  const cut = splitTurns(rows).filter(t => t.index < 5)
  expect(pruneMessages(rows, cut, '')[0].text).toBe('[removido: 6 turnos (pedidos do usuário e respostas do Claude): a | b | c | d | e | f]')
  expect(splitTurns(rows)[0].preview).toBe('[removido: 3 turnos: a | b | c]')
})

test('the model lists, marks and unmarks its own turns only', () => {
  const listing = toolListing(talk, [{ index: 2, head: 'second' }])
  expect(listing.split('\n').map(l => l.split(' ~')[0])).toEqual(['#0 [ ]', '#2 [U]', '#7 [ ]'])
  const marked = applyToolMarks(talk, [{ index: 2, head: 'second' }], 'mark', [7, 6, 9, 2])
  expect(marked.marks.at(-1)).toEqual({ index: 7, head: 'third', fromEnd: 3, by: 'claude' })
  expect(marked.marks.length).toBe(2)
  expect(marked.refused.length).toBe(2)
  expect(toolListing(talk, marked.marks)).toContain('#7 [C]')
  const unmarked = applyToolMarks(talk, marked.marks, 'unmark', [7, 2])
  expect(unmarked.marks).toEqual([{ index: 2, head: 'second' }])
  expect(unmarked.refused).toEqual(['#2: marcado pelo usuário; só ele desmarca'])
})

// A PNG's first 24 bytes, its size in the header, as base64.
function pngData(width: number, height: number): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  for (const n of [width, height]) bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63]
  }
  return out
}

test('an image weighs by its size, shrunk as the API shrinks it', () => {
  expect(imageTokens(200, 200)).toBe(54)
  expect(imageTokens(1920, 1032)).toBe(1534)
  expect(imageTokens(4000, 4000)).toBe(1534)
})

test('a row tells its prompt key and its images', () => {
  const image = { type: 'image', source: { type: 'base64', data: pngData(1920, 1032) } }
  expect(describeRow({ type: 'user', content: [image, { type: 'text', text: 'look  at\nthis' }] })).toEqual({
    promptKey: 'look at this',
    images: { tokens: 1534, count: 1 },
  })
  const shot = { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { data: 'x' } }] }
  expect(describeRow({ type: 'user', content: [shot] })).toEqual({
    images: { tokens: 1600, count: 1, fromTool: true },
  })
  expect(describeRow({ type: 'user', isMeta: true, content: [{ type: 'text', text: 'reminder' }] })).toEqual({})
  expect(describeRow({ type: 'user', content: [{ type: 'text', text: '<command-name>/prune</command-name>' }] })).toEqual({})
})

test('images show above the turn their prompt names; an image-only prompt is its turn', () => {
  const rows = [prompt('first'), reply('a'), prompt('look at this\n[print removido]'), reply('b'), prompt(''), reply('c')]
  const turns = splitTurns(rows)
  const images = [
    { uuid: 'i1', key: 'look at this', tokens: 1500, count: 1 },
    { uuid: 'i2', key: 'first', tokens: 900, count: 1, fromTool: true as const },
    { uuid: 'i3', key: '', tokens: 1000, count: 1 },
    { uuid: 'i4', key: '', tokens: 1600, count: 1, fromTool: true as const },
    { uuid: 'i5', key: 'gone', tokens: 1600, count: 1 },
    ...normalizeImages(['old']),
  ]
  const { byTurn, loose } = placeImages(turns, images)
  expect([...byTurn].map(([index, list]) => [index, list.map(r => r.uuid)])).toEqual([
    [2, ['i1']],
    [0, ['i2']],
  ])
  expect(loose.map(r => r.uuid)).toEqual(['i4', 'i5', 'old'])
})

test('a marked image starts the rewrite at its own turn', () => {
  const turns = splitTurns(talk)
  const images = new Map([[2, [{ uuid: 'i', key: 'second', tokens: 1500, count: 1, isMarked: true as const }]]])
  expect(rewrittenTokens(turns, [], images)).toBe(turns[1].tokens + turns[2].tokens + turns[3].tokens + turns[4].tokens)
})

test('a turn weighs what its end adds past the previous end', () => {
  expect(boundaryOf(1000, 'abcdefgh')).toBe(1002)
  expect(measureTurn(1002, 3500)).toBe(2498)
  expect(measureTurn(null, 3500)).toBe(undefined)
  expect(measureTurn(5000, 3500)).toBe(undefined)
  expect(recordTurn({ a: 1, b: 2 }, 'a', 5)).toEqual({ b: 2, a: 5 })
})

test('measured weights replace the estimate, less the turn images rows', () => {
  const turns = splitTurns(talk)
  const images = new Map([[7, [{ uuid: 'i', key: 'third', tokens: 1500, count: 1 }]]])
  const out = withMeasured(turns, { second: 4000, third: 5000, '': 99 }, images)
  expect(out.map(t => [t.tokens, t.isMeasured])).toEqual([
    [turns[0].tokens, undefined],
    [4000, true],
    [turns[2].tokens, undefined],
    [3500, true],
    [turns[4].tokens, undefined],
  ])
})

test('the request form weighs each turn with its thinking', () => {
  const api = [
    { role: 'user' as const, content: [{ type: 'text', text: '<system-reminder>\nr\n</system-reminder>' }, { type: 'text', text: 'first' }] },
    { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'x'.repeat(400), signature: 's'.repeat(999) }, { type: 'text', text: 'one' }] },
    { role: 'user' as const, content: [{ type: 'text', text: '<command-name>/prune</command-name>' }, { type: 'text', text: 'second' }] },
    { role: 'assistant' as const, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a'.repeat(80) }] },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'two' }] },
  ]
  const estimates = apiEstimates(api)
  expect(estimates.map(e => e.key)).toEqual(['first', 'second'])
  expect(estimates[0].tokens).toBeGreaterThan(100)
  const turns = withEstimates(splitTurns(talk), estimates)
  expect(turns[0].tokens).toBe(estimates[0].tokens)
  expect(turns[1].tokens).toBe(Math.max(splitTurns(talk)[1].tokens, estimates[1].tokens))
  expect(turns[3].tokens).toBe(splitTurns(talk)[3].tokens)
})

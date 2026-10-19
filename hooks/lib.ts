import type { ApiContentBlock, ApiMessage, SessionMessage } from 'claude-code'

import type { ImageRow, Mark, Meter, LiveAnchor } from '../types'
import type { Lang, Texts } from './i18n'
import { isLang, TEXTS, textsFor } from './i18n'

// Prompt-cache lifetime of this account's requests. Each request renews the
// whole cached prefix; on usage overage it drops to 5 minutes, which a mod
// cannot see, so it is a constant.
export const CACHE_TTL_MS = 60 * 60 * 1000

export type Cache = { isWarm: true; minutesLeft: number } | { isWarm: false } | null

// Per session id, kept in a file of the mod's own (neither $.state nor $.store
// read back what was written before a process restart): when the last request
// ended, so the cache state survives restarting Claude.
export type SessionRecord = {
  lastRequestAt?: number
  marks?: Mark[]
  images?: (ImageRow | string)[]
  turnTokens?: Record<string, number>
  boundary?: number | null
}
export type Records = Record<string, SessionRecord>

// Sessions untouched this long are dropped from the file.
const RECORD_KEEP_MS = 30 * 24 * 60 * 60 * 1000

// The data file in Claude's config folder (CLAUDE_CONFIG_DIR, else ~/.claude),
// outside the plugin folder so a write never triggers a hot reload.
export function dataPathFor(env: { configDir?: string; home?: string }): string | undefined {
  const config = env.configDir || (env.home && `${env.home}/.claude`)
  if (!config) return undefined
  return `${config.replaceAll('\\', '/').replace(/\/+$/, '')}/plugins/data/context-prune/sessions.json`
}

// Choices that hold across conversations (the language), beside the
// sessions' file.
export type Preferences = { language?: Lang }

export function preferencesPathFor(dataPath: string): string {
  return dataPath.replace(/sessions\.json$/, 'preferences.json')
}

export function parsePreferences(text: string | undefined): Preferences {
  try {
    const value = text === undefined ? {} : JSON.parse(text)
    return value && typeof value === 'object' && isLang(value.language) ? { language: value.language } : {}
  } catch {
    return {}
  }
}

export function parseRecords(text: string | undefined): Records {
  try {
    const value = text === undefined ? {} : JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const records: Records = {}
    for (const [id, r] of Object.entries(value)) {
      if (r && typeof r === 'object') records[id] = r as SessionRecord
    }
    return records
  } catch {
    return {}
  }
}

// Merges `patch` into `sessionId`'s record, stamped `now`, and drops sessions
// untouched for RECORD_KEEP_MS.
export function updateRecord(records: Records, sessionId: string, patch: SessionRecord, now: number): Records {
  const kept: Records = {}
  for (const [id, r] of Object.entries(records)) {
    if (now - (r.lastRequestAt ?? 0) < RECORD_KEEP_MS) kept[id] = r
  }
  kept[sessionId] = { ...kept[sessionId], ...patch }
  return kept
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toString()}k`
  return String(n)
}

export function percentOf(meter: Meter): number | undefined {
  if (meter.tokens === undefined || meter.window <= 0) return undefined
  return Math.round((meter.tokens / meter.window) * 100)
}

export function cacheState(lastRequestAt: number | null, now: number, ttlMs = CACHE_TTL_MS): Cache {
  if (lastRequestAt === null) return null
  const left = lastRequestAt + ttlMs - now
  if (left <= 0) return { isWarm: false }
  return { isWarm: true, minutesLeft: Math.ceil(left / 60_000) }
}

export function contextLabel(meter: Meter): string | undefined {
  if (meter.tokens === undefined) return undefined
  return `context ${meter.isEstimate ? '~' : ''}${formatTokens(meter.tokens)} / ${formatTokens(meter.window)} (${percentOf(meter)}%)`
}

// The status line beside the model picker, in the person's words.
export function statusLabel(cache: Cache, lang: Lang): string | undefined {
  if (cache === null) return undefined
  const t = textsFor(lang)
  return cache.isWarm ? t.statusWarm(cache.minutesLeft) : t.statusCold
}

// One line beside each prompt, so the model reasons with real numbers. The
// cache state is left out: by the time the model reads it, the request has
// already warmed the cache again, and the choice it bears on (send here or
// start fresh) is the person's, made from the status line before sending.
export function modelNote(meter: Meter): string | undefined {
  const context = contextLabel(meter)
  return context && `context-prune: ${context} tokens.`
}

// --- /prune ---------------------------------------------------------------

// The instructions /prune hands /compact, so the compaction it starts is told
// apart from the person's own /compact; the description follows.
export const PRUNE_TAG = 'context-prune:prune'

export function pruneDescription(instructions: string | undefined): string | undefined {
  if (instructions === undefined || !instructions.startsWith(PRUNE_TAG)) return undefined
  return instructions.slice(PRUNE_TAG.length).trim()
}

// One prompt of the person's and everything that answered it (the model's
// messages, tool calls and their results), up to the next prompt.
export type Turn = {
  /** Index of the prompt in the conversation's messages. */
  index: number
  /** Index one past the turn's last message. */
  end: number
  preview: string
  /** The prompt's text as stored, to check a mark still points at it. */
  head: string
  /** Rough size of its text, in tokens (characters / 4); images apart (ImageRow). */
  tokens: number
  /** A slash command's rows rather than a prompt. */
  isCommand: boolean
  /** `tokens` was measured when the turn ended, not estimated from its text. */
  isMeasured?: true
}

const HEAD_CHARS = 80
// A prompt with no text carried only media: its preview is empty, and the
// pane names it in the person's language.
const MEDIA_ONLY = ''

// A prompt's text less what a prune wrote into it, in any language: the
// removed-print line, and who the removed turns were from.
function withoutPruneMarks(text: string): string {
  let out = text
  for (const t of Object.values(TEXTS)) out = out.replaceAll(t.mediaRemoved, '').replaceAll(` (${t.removedWho})`, '')
  return out
}
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function isPromptStart(m: SessionMessage): boolean {
  return m.role === 'user' && !m.toolResults?.length
}

export function previewOf(text: string): string {
  return text.replace(REMINDER, ' ').replace(/\s+/g, ' ').trim().slice(0, HEAD_CHARS)
}

export function estimateTokens(m: SessionMessage): number {
  let chars = m.text.length
  for (const use of m.toolUses) chars += JSON.stringify(use.input ?? {}).length
  for (const result of m.toolResults ?? []) chars += result.text.length
  return Math.ceil(chars / 4)
}

export function splitTurns(messages: readonly SessionMessage[]): Turn[] {
  const turns: Turn[] = []
  messages.forEach((m, i) => {
    const last = turns[turns.length - 1]
    if (isPromptStart(m) || !last) {
      if (last) last.end = i
      turns.push({
        index: i,
        end: messages.length,
        // The pane leaves out the line a removed print left; the model keeps it.
        preview: previewOf(withoutPruneMarks(m.text)) || MEDIA_ONLY,
        head: m.text.slice(0, HEAD_CHARS),
        tokens: 0,
        isCommand: /^\s*<(command-name|local-command)/.test(m.text),
      })
    }
    turns[turns.length - 1].tokens += estimateTokens(m)
  })
  return turns
}

// Where a mark points: by the row's uuid (the compact's handle) when it has
// one, else the turn whose prompt still reads as marked, the nearest to where
// it was (counted from the end, which rows prepended to a list do not move).
// Undefined when the conversation no longer holds it.
function findMark(messages: readonly SessionMessage[], turns: readonly Turn[], mark: Mark): Turn | undefined {
  if (mark.uuid !== undefined) return turns.find(turn => messages[turn.index].handle === mark.uuid)
  const distance = (turn: Turn) =>
    mark.fromEnd !== undefined
      ? Math.abs(messages.length - turn.index - mark.fromEnd)
      : Math.abs(turn.index - (mark.index ?? 0))
  let best: Turn | undefined
  for (const turn of turns) {
    if (turn.head !== mark.head) continue
    if (!best || distance(turn) < distance(best)) best = turn
  }
  return best
}

// The conversation the model reads, out of a live list that may still hold
// the rows a compaction replaced ahead of it: from the last row that opens
// it as the compaction left it, with room for all it left. The whole list
// when there is no anchor or nothing matches (a restart reads the live rows
// alone).
export function liveSlice<M extends { text: string }>(all: readonly M[], anchor: LiveAnchor | null): readonly M[] {
  if (!anchor) return all
  for (let i = all.length - anchor.count; i >= 0; i--) {
    if (all[i].text.slice(0, HEAD_CHARS) === anchor.head) return all.slice(i)
  }
  return all
}

// Whether the live list already ends with everything the compaction left.
export function endsWithAnchor(all: readonly { text: string }[], anchor: LiveAnchor | null): boolean {
  if (!anchor) return true
  return all[all.length - anchor.count]?.text.slice(0, HEAD_CHARS) === anchor.head
}

export function anchorOf(messages: readonly { text: string }[]): LiveAnchor | null {
  return messages.length ? { head: messages[0].text.slice(0, HEAD_CHARS), count: messages.length } : null
}

// The turns the marks point at, and the marks that point at none.
export function matchMarks(messages: readonly SessionMessage[], marks: readonly Mark[]) {
  const turns = splitTurns(messages)
  const found = new Map<Mark, Turn>()
  const missed: Mark[] = []
  for (const mark of marks) {
    const turn = findMark(messages, turns, mark)
    if (turn) found.set(mark, turn)
    else missed.push(mark)
  }
  const marked = new Set(found.values())
  // Commands the pane hides that sit between two marked turns go with them,
  // so turns that read as neighbours there leave one line.
  const isMarkedAround = (i: number, step: number) => {
    let j = i + step
    while (j >= 0 && j < turns.length && turns[j].isCommand && !marked.has(turns[j])) j += step
    return j >= 0 && j < turns.length && marked.has(turns[j])
  }
  const cut = turns.filter(
    (turn, i) => marked.has(turn) || (turn.isCommand && isMarkedAround(i, -1) && isMarkedAround(i, 1)),
  )
  return { cut, found, missed }
}

export function markedTurns(messages: readonly SessionMessage[], marks: readonly Mark[]): Turn[] {
  return matchMarks(messages, marks).cut
}

// The conversation with the marked turns taken out whole, each run of
// neighbouring cuts replaced by one line. The first message's reminders (the
// session's instructions) are kept on that line when it is cut.
export function pruneMessages(
  messages: readonly SessionMessage[],
  cut: readonly Turn[],
  description: string,
  lang: Lang,
): SessionMessage[] {
  const t = textsFor(lang)
  const out: SessionMessage[] = []
  const starts = new Map(cut.map(turn => [turn.index, turn]))
  let i = 0
  while (i < messages.length) {
    if (!starts.has(i)) {
      out.push(messages[i])
      i += 1
      continue
    }
    const run: Turn[] = []
    for (let turn = starts.get(i); turn; turn = starts.get(i)) {
      run.push(turn)
      i = turn.end
    }
    const pieces = run.filter(turn => !turn.isCommand).map(turn => removedParts(messages[turn.index], turn, t))
    const count = pieces.reduce((sum, piece) => sum + piece.count, 0)
    const label = pieces.length
      ? removedLabel(count, description ? [description] : pieces.flatMap(piece => piece.parts), lang)
      : t.removedCommands
    const reminders = run[0].index === 0 ? (messages[0].text.match(REMINDER) ?? []) : []
    out.push({ role: 'user', text: [...reminders, label].join('\n'), toolUses: [] })
  }
  return out
}

// The line a prune leaves, as the model reads it: how many turns went and the
// head of each prompt, so it knows what it no longer has. A line in either
// language is read back, so a later prune merges it whatever the language.
const REMOVED_LINE = /^\[(?:removido|removed): (\d+) (?:turnos?|turns?) \([^)]*\): ([\s\S]*)\]$/
const LEGACY_LINE = /^\[(?:removido|removed): ([\s\S]*)\]$/

export function removedLabel(count: number, parts: readonly string[], lang: Lang): string {
  const t = textsFor(lang)
  return t.removedLine(count, t.removedWho, parts.join(' | '))
}

// Parts joined by ' | ' outside brackets.
function countParts(text: string): number {
  let depth = 0
  let parts = 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') depth += 1
    else if (text[i] === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && text.startsWith(' | ', i)) parts += 1
  }
  return parts
}

// What one cut turn adds to the line: a line an earlier prune left counts as
// the turns it names, so pruning it again does not nest the count.
function removedParts(m: SessionMessage, turn: Turn, t: Texts): { count: number; parts: string[] } {
  const text = m.text.replace(REMINDER, ' ').trim()
  const line = text.match(REMOVED_LINE)
  if (line) return { count: Number(line[1]), parts: [line[2]] }
  // A line from before the count was written: one turn per part.
  const legacy = text.match(LEGACY_LINE)
  if (legacy) return { count: countParts(legacy[1]), parts: [legacy[1]] }
  return { count: 1, parts: [turn.preview || t.imagesAttached(1)] }
}

// Tokens the marked turns hold, as estimated.
export function removedTokens(cut: readonly Turn[]): number {
  return cut.reduce((sum, turn) => sum + turn.tokens, 0)
}

// What the next request writes to the cache again after a prune: the turns
// kept after the first cut (what comes before it is still read from the cache,
// as measured on the app). Estimated, as the turns' tokens are.
// A marked image starts a cut at its own turn: the row it sits in is rebuilt.
export function rewrittenTokens(
  turns: readonly Turn[],
  cut: readonly Turn[],
  images: ReadonlyMap<number, readonly ImageRow[]> = new Map(),
): number {
  const imageTurns = [...images].filter(([, rows]) => rows.some(r => r.isMarked)).map(([index]) => index)
  const starts = [...cut.map(t => t.index), ...imageTurns]
  if (starts.length === 0) return 0
  const first = Math.min(...starts)
  const cutAt = new Set(cut.map(t => t.index))
  const kept = turns.filter(t => !cutAt.has(t.index) && (t.index > first || imageTurns.includes(t.index)))
  const text = kept.reduce((sum, t) => sum + t.tokens, 0)
  const left = kept
    .filter(t => t.index > first)
    .flatMap(t => images.get(t.index) ?? [])
    .filter(r => !r.isMarked)
  return text + left.reduce((sum, r) => sum + r.tokens, 0)
}

// Whether /prune runs on its own before a prompt: only on a cold cache, where
// the request writes the whole conversation anyway. On a warm one what comes
// after the first cut would be written again at twice the price, so what is
// pending waits.
export function shouldAutoPrune(hasPending: boolean, cache: Cache): boolean {
  return hasPending && cache !== null && !cache.isWarm
}

// --- prints ---------------------------------------------------------------

// Whether a row's blocks hold an image, at the top or inside a tool result.
export function hasImage(content: readonly ApiContentBlock[]): boolean {
  return content.some(
    block =>
      block.type === 'image' ||
      (block.type === 'tool_result' &&
        Array.isArray(block.content) &&
        (block.content as ApiContentBlock[]).some(inner => inner?.type === 'image')),
  )
}

// The rows with images rebuilt without their handle: the engine builds such a
// row from its text and tool blocks alone, so the image goes and a line says
// so. Same length and order, so turn indices still hold.
export function stripImages(messages: readonly SessionMessage[], rows: ReadonlySet<string>, lang: Lang): SessionMessage[] {
  const removed = textsFor(lang).mediaRemoved
  return messages.map(m => {
    if (m.handle === undefined || !rows.has(m.handle)) return m
    return {
      role: m.role,
      text: m.text ? `${m.text}\n${removed}` : removed,
      toolUses: m.toolUses,
      ...(m.toolResults ? { toolResults: m.toolResults } : {}),
    }
  })
}

// Which turn a prompt's text names, as the pane and session.append both read
// it: the head of its preview, less what a prune left in it.
export function promptKey(text: string): string {
  return previewOf(withoutPruneMarks(text)).slice(0, 60)
}

export function turnKey(turn: Turn): string {
  return turn.preview === MEDIA_ONLY ? '' : turn.preview.slice(0, 60)
}

// What session.append's row says for the images: whether it is a prompt the
// person typed (its key starts a turn) and the images it carries.
export function describeRow(message: {
  type: string
  isMeta?: true
  content: readonly ApiContentBlock[]
}): { promptKey?: string; images?: { tokens: number; count: number; fromTool?: true } } {
  const isToolResult = message.content.some(block => block.type === 'tool_result')
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
  const isCommand = /^\s*<(local-)?command-/.test(text)
  const isPrompt = message.type === 'user' && !message.isMeta && !isToolResult && !isCommand
  const blocks = message.content.flatMap(block =>
    block.type === 'image'
      ? [block]
      : block.type === 'tool_result' && Array.isArray(block.content)
        ? (block.content as ApiContentBlock[]).filter(inner => inner?.type === 'image')
        : [],
  )
  return {
    ...(isPrompt ? { promptKey: promptKey(text) } : {}),
    ...(blocks.length
      ? {
          images: {
            tokens: blocks.reduce((sum, block) => sum + imageTokensOf(block), 0),
            count: blocks.length,
            ...(isToolResult ? { fromTool: true as const } : {}),
          },
        }
      : {}),
  }
}

// An image's tokens as the API counts them (width * height / 750), after it
// shrinks to fit 1568 px on the long edge and about 1.15 megapixels. The size
// is read from a PNG's header; any other kind counts as the largest.
export const IMAGE_MAX_TOKENS = 1600

export function imageTokens(width: number, height: number): number {
  let scale = Math.min(1, 1568 / Math.max(width, height))
  scale = Math.min(scale, Math.sqrt(1_150_000 / (width * height)))
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil((width * scale * (height * scale)) / 750))
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeHead(data: string, bytes: number): number[] {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < data.length && out.length < bytes; i++) {
    const value = BASE64.indexOf(data[i])
    if (value < 0) continue
    buffer = ((buffer << 6) | value) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return out
}

export function imageTokensOf(block: ApiContentBlock): number {
  const source = block.source as { data?: unknown } | undefined
  if (typeof source?.data !== 'string') return IMAGE_MAX_TOKENS
  const b = decodeHead(source.data, 24)
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return IMAGE_MAX_TOKENS
  const u32 = (at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  const width = u32(16)
  const height = u32(20)
  return width > 0 && height > 0 ? imageTokens(width, height) : IMAGE_MAX_TOKENS
}

// A stored image row, whichever shape it was written in.
export function normalizeImages(rows: readonly (ImageRow | string)[] | undefined): ImageRow[] {
  return (rows ?? []).map(row =>
    typeof row === 'string' ? { uuid: row, key: '', tokens: IMAGE_MAX_TOKENS, count: 1, isLegacy: true } : row,
  )
}

// Where each image shows in the pane: under the latest turn its prompt names.
// A prompt that is only an image is its turn already, and shows no row of its
// own; a tool's image whose turn is not found shows apart (loose).
export function placeImages(turns: readonly Turn[], images: readonly ImageRow[]) {
  const byTurn = new Map<number, ImageRow[]>()
  const loose: ImageRow[] = []
  for (const image of images) {
    if (image.key === '' && !image.fromTool && !image.isLegacy) continue
    // A loop, not findLast: the hooks' runtime may predate it.
    let turn: Turn | undefined
    for (let i = turns.length - 1; i >= 0 && image.key !== '' && !turn; i--) {
      if (!turns[i].isCommand && turnKey(turns[i]) === image.key) turn = turns[i]
    }
    if (!turn) loose.push(image)
    else byTurn.set(turn.index, [...(byTurn.get(turn.index) ?? []), image])
  }
  return { byTurn, loose }
}

// How many of the recorded image rows the conversation still holds.
export function countImages(messages: readonly SessionMessage[], rows: ReadonlySet<string>): number {
  return messages.filter(m => m.handle !== undefined && rows.has(m.handle)).length
}

// --- the model's own marks --------------------------------------------------

// The turns the model may mark: not a command, not the one in progress.
function markableTurns(messages: readonly SessionMessage[]): Turn[] {
  return splitTurns(messages).filter((turn, i, all) => !turn.isCommand && i < all.length - 1)
}

// The list the model reads from its tool, only when it calls it: each turn
// numbered by position, with who marked it ([C] the model, [U] the person).
export function toolListing(
  messages: readonly SessionMessage[],
  marks: readonly Mark[],
  weighted: readonly Turn[] = [],
): string {
  const { found } = matchMarks(messages, marks)
  const by = new Map([...found].map(([mark, turn]) => [turn.index, mark.by === 'claude' ? '[C]' : '[U]']))
  const weights = new Map(weighted.map(turn => [turn.index, turn]))
  const lines = markableTurns(messages).map(turn => {
    const weight = weights.get(turn.index) ?? turn
    const tokens = `${weight.isMeasured ? '' : '~'}${formatTokens(weight.tokens)}`
    return `#${turn.index} ${by.get(turn.index) ?? '[ ]'} ${tokens} ${turn.preview || '[image]'}`
  })
  return lines.join('\n')
}

// Marks or unmarks turns by the numbers toolListing gave. The model unmarks
// its own marks only: the person's stay as the person left them.
export function applyToolMarks(
  messages: readonly SessionMessage[],
  marks: readonly Mark[],
  action: 'mark' | 'unmark',
  numbers: readonly number[],
): { marks: Mark[]; refused: string[] } {
  const turns = new Map(markableTurns(messages).map(turn => [turn.index, turn]))
  const { found } = matchMarks(messages, marks)
  const markOn = (index: number) => [...found].find(([, turn]) => turn.index === index)?.[0]
  let next = [...marks]
  const refused: string[] = []
  for (const n of numbers) {
    const turn = turns.get(n)
    const mark = markOn(n)
    if (!turn) refused.push(`#${n}: not a turn that can be marked (a command, the current turn, or no such number)`)
    else if (action === 'mark' && !mark) {
      next.push({ index: turn.index, head: turn.head, fromEnd: messages.length - turn.index, by: 'claude' })
    } else if (action === 'unmark' && mark) {
      if (mark.by === 'claude') next = next.filter(m => m !== mark)
      else refused.push(`#${n}: marked by the user; only the user unmarks it`)
    }
  }
  return { marks: next, refused }
}

// --- measured turn weights ------------------------------------------------

// Where a turn ends, in tokens: the context its last request read, plus its
// final answer, which only the next request reads (estimated from its text).
export function boundaryOf(contextTokens: number, answer: string): number {
  return contextTokens + Math.ceil(answer.length / 4)
}

// A turn's weight: how far its end is past the previous turn's. Unknown with
// no previous end (the first turn after a compaction) or when it went back.
export function measureTurn(previous: number | null | undefined, boundary: number): number | undefined {
  if (previous === null || previous === undefined) return undefined
  const delta = boundary - previous
  return delta > 0 ? delta : undefined
}

// Keeps the newest weights only, so the record does not grow without end.
const TURN_TOKENS_KEPT = 300

export function recordTurn(weights: Record<string, number>, key: string, tokens: number): Record<string, number> {
  const { [key]: _, ...rest } = weights
  const entries = [...Object.entries(rest), [key, tokens] as const]
  return Object.fromEntries(entries.slice(-TURN_TOKENS_KEPT))
}

// The turns with their measured weight where there is one: what the turn's
// own images are estimated at is left to their rows, so nothing counts twice.
export function withMeasured(
  turns: readonly Turn[],
  weights: Readonly<Record<string, number>>,
  images: ReadonlyMap<number, readonly ImageRow[]> = new Map(),
): Turn[] {
  return turns.map(turn => {
    const key = turnKey(turn)
    const weight = key === '' || turn.isCommand ? undefined : weights[key]
    if (weight === undefined) return turn
    const inImages = (images.get(turn.index) ?? []).reduce((sum, row) => sum + row.tokens, 0)
    return { ...turn, tokens: Math.max(0, weight - inImages), isMeasured: true }
  })
}

// --- estimates from the request form --------------------------------------

// The conversation as the next request carries it holds what the rows leave
// out, the model's thinking above all: each turn is estimated from there.
function blockChars(block: ApiContentBlock): number {
  switch (block.type) {
    case 'text':
      return String(block.text ?? '').length
    case 'thinking':
      return String(block.thinking ?? '').length
    case 'tool_use':
      return JSON.stringify(block.input ?? {}).length
    case 'tool_result':
      if (typeof block.content === 'string') return block.content.length
      if (!Array.isArray(block.content)) return 0
      return (block.content as ApiContentBlock[]).reduce(
        (sum, inner) => sum + (inner?.type === 'text' ? String(inner.text ?? '').length : 0),
        0,
      )
    default:
      return 0
  }
}

// The prompt a user message of the request form opens a turn with, or none
// (a tool result). Rows the request merges into one message (a command's
// lines and the prompt after them) are told apart by their blocks.
function apiPromptKey(m: ApiMessage): string | undefined {
  if (m.role !== 'user' || m.content.some(block => block.type === 'tool_result')) return undefined
  const texts = m.content
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .filter(text => !/^\s*<(local-)?command-/.test(text))
  return promptKey(texts.join('\n'))
}

// Each turn of the request form, in order: its prompt's key and its weight.
export function apiEstimates(api: readonly ApiMessage[]): { key: string; tokens: number }[] {
  const out: { key: string; tokens: number }[] = []
  for (const m of api) {
    const key = apiPromptKey(m)
    if (key !== undefined || out.length === 0) out.push({ key: key ?? '', tokens: 0 })
    const chars = m.content.reduce((sum, block) => sum + blockChars(block), 0)
    out[out.length - 1].tokens += Math.ceil(chars / 4)
  }
  return out
}

// The turns with the request form's estimate, matched by prompt key in
// order (prompts that read alike pair up one by one); the rest keep theirs.
export function withEstimates(turns: readonly Turn[], estimates: readonly { key: string; tokens: number }[]): Turn[] {
  let cursor = 0
  return turns.map(turn => {
    const key = turnKey(turn)
    if (turn.isCommand || key === '') return turn
    for (let i = cursor; i < estimates.length; i++) {
      if (estimates[i].key !== key) continue
      cursor = i + 1
      return { ...turn, tokens: Math.max(turn.tokens, estimates[i].tokens) }
    }
    return turn
  })
}

// --- pane ---------------------------------------------------------------------

// The context bar the pane draws on the desktop: the window as a track, the
// context in it, and the part marked for removal at its end. Plain colors
// that read on a light and a dark theme alike (an image takes no theme).
export function contextBarSvg(tokens: number, marked: number, window: number): string {
  const W = 360
  const H = 8
  const total = Math.max(window, tokens, 1)
  const used = Math.round((Math.min(tokens, total) / total) * W)
  const cut = Math.min(used, Math.round((Math.max(0, marked) / total) * W))
  const kept = used - cut
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" rx="${H / 2}" fill="#8a8a8a" fill-opacity="0.25"/>`,
    `<clipPath id="r"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${kept}" height="${H}" fill="#5b8def"/>`,
    cut > 0 ? `<rect x="${kept}" width="${cut}" height="${H}" fill="#d97757"/>` : '',
    `</g></svg>`,
  ].join('')
}

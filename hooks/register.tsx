import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, ResolveInput, SessionMessage } from 'claude-code'

import type { ImageRow, Mark, Meter } from '../types'
import type { SessionRecord } from './lib'
import {
  cacheState,
  dataPathFor,
  anchorOf,
  endsWithAnchor,
  countImages,
  formatTokens,
  describeRow,
  boundaryOf,
  measureTurn,
  recordTurn,
  withMeasured,
  apiEstimates,
  withEstimates,
  normalizeImages,
  placeImages,
  applyToolMarks,
  matchMarks,
  toolListing,
  modelNote,
  parseRecords,
  PRUNE_TAG,
  pruneDescription,
  pruneMessages,
  removedTokens,
  rewrittenTokens,
  shouldAutoPrune,
  splitTurns,
  statusLabel,
  stripImages,
  liveSlice,
  updateRecord,
} from './lib'

// The prompt cache's warm/cold state as the plugin's status line (beside the
// model picker on the desktop, from the moment the conversation opens), and
// the context fill as one line the model reads with each prompt. The last
// request's time is kept in a data file, so the state survives a restart.
//
// /prune takes whole turns out of the context (the prompt and everything that
// answered it), leaving one `[removido: ...]` line, with no summary and no
// model call: a /compact the mod starts and answers itself. Turns are marked
// in a pane; the marks are kept in the data file too. The same prune can take
// marked images out (a `[print removido]` line in their place), from the rows
// session.append saw carry one; the pane lists each above its prompt. What is pending waits while the cache is warm
// (what comes after the first cut would be cached again) and applies on its own
// before the first prompt sent once it is cold.

const meter = atom({ plugin: 'context-prune', key: 'meter' } as const, null)
const marksAtom = atom({ plugin: 'context-prune', key: 'marks' } as const, [])
const imagesAtom = atom({ plugin: 'context-prune', key: 'images' } as const, [])
const promptKeyAtom = atom({ plugin: 'context-prune', key: 'promptKey' } as const, '')
const turnTokensAtom = atom({ plugin: 'context-prune', key: 'turnTokens' } as const, {})
const boundaryAtom = atom({ plugin: 'context-prune', key: 'boundary' } as const, null)
const liveAnchorAtom = atom({ plugin: 'context-prune', key: 'liveAnchor' } as const, null)

// The rows the model reads now, as session.compact's messages line them up.
async function liveMessages($: EngineInterface) {
  return liveSlice(await $.session.messages(), (await read($, liveAnchorAtom)) ?? null)
}

// The model's own marks: a tool it loads through ToolSearch, so it costs a
// name per request, and the list of marks reaches it only when it calls.
const MARK_TOOL = 'prune_marks'
const MARK_TOOL_ID = 'mcp__context-prune__prune_marks'
const MARK_TOOL_DESCRIPTION = [
  "Marks finished turns of this conversation for removal from the context (the Context Prune plugin's /prune).",
  'A turn is one user prompt and everything that answered it, tool calls included.',
  'Marked turns are replaced by one line, `[removido: N turnos (...): <prompt heads>]`, once the prompt cache is cold (an hour idle): the plugin prunes while the conversation sits idle, or the user prunes from the pane.',
  'The user sees your marks as [C] in the /prune pane and can unmark them.',
  'Mark what the rest of the work no longer needs: setup or debugging that ended in a fix, probes, superseded attempts, test confirmations.',
  'Keep turns that carry the goal, decisions, constraints or facts still relied on (a later turn may say "what I asked in the first message").',
  "Call `list` first: it numbers the turns and shows the marks ([C] yours, [U] the user's). Then `mark` or `unmark` with those numbers; you unmark only your own marks.",
].join(' ')

// How long after the session starts a cold conversation is pruned.
const IDLE_PRUNE_DELAY_MS = 5_000

// The cache countdown changes with time alone: refresh the status each minute.
const REDRAW_MS = 60_000

const PANE = 'context-prune-prune'
const PANE_TITLE = 'Podar contexto'
// The pane lists the newest prompts only.
const PANE_ROWS = 40

async function showStatus($: EngineInterface) {
  const current = await read($, meter)
  const label = current ? statusLabel(cacheState(current.lastRequestAt, await $.clock.now())) : undefined
  $.ui.status(label)
}

let dataPathCache: Promise<string | undefined> | undefined

function dataPath($: EngineInterface) {
  dataPathCache ??= (async () =>
    dataPathFor({
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      home: (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
    }))()
  return dataPathCache
}

async function readRecords($: EngineInterface, path: string) {
  return parseRecords(await $.fs.read(path).catch(() => undefined))
}

async function saveRecord($: EngineInterface, patch: SessionRecord) {
  const path = await dataPath($)
  if (!path) return
  const now = await $.clock.now()
  const records = updateRecord(await readRecords($, path), await $.session.id(), patch, now)
  await $.fs.write(path, JSON.stringify(records, null, 2) + '\n')
}

async function renewCache($: EngineInterface) {
  const now = await $.clock.now()
  await update($, meter, current => (current ? { ...current, lastRequestAt: now } : current))
  await saveRecord($, { lastRequestAt: now })
  await showStatus($)
}

async function patchMeter($: EngineInterface, patch: Partial<Meter> & { window: number }) {
  await update($, meter, current => ({
    lastRequestAt: null,
    ...current,
    ...patch,
  }))
}

async function setMarks($: EngineInterface, change: (marks: Mark[]) => Mark[]) {
  const marks = await update($, marksAtom, current => change(current ?? []))
  await saveRecord($, { marks })
}

async function setBoundary($: EngineInterface, boundary: number | null) {
  await update($, boundaryAtom, () => boundary)
  await saveRecord($, { boundary })
}

// The end of a main-loop turn: what it added past the previous end is its
// weight, kept under its prompt's key for the pane.
async function measureTurnEnd($: EngineInterface, answer: string) {
  const tokens = (await read($, meter))?.tokens
  if (tokens === undefined) return
  const boundary = boundaryOf(tokens, answer)
  const weight = measureTurn(await read($, boundaryAtom), boundary)
  const key = (await read($, promptKeyAtom)) ?? ''
  if (weight !== undefined && key !== '') {
    const turnTokens = await update($, turnTokensAtom, current => recordTurn(current ?? {}, key, weight))
    await saveRecord($, { turnTokens })
  }
  await setBoundary($, boundary)
}

// The turns weighed as well as the mod can: measured when they ended, else
// estimated from the request form (thinking included), else from the rows.
async function weighTurns($: EngineInterface, messages: readonly SessionMessage[]) {
  const turns = splitTurns(messages)
  const { byTurn, loose } = placeImages(turns, await readImages($))
  const api = await $.session.messages({ as: 'api' })
  const estimated = withEstimates(turns, apiEstimates(api))
  const weighed = withMeasured(estimated, (await read($, turnTokensAtom)) ?? {}, byTurn)
  return { turns: weighed, byTurn, loose }
}

async function readImages($: EngineInterface) {
  return normalizeImages((await read($, imagesAtom)) ?? [])
}

async function setImages($: EngineInterface, change: (images: ImageRow[]) => ImageRow[]) {
  const images = await update($, imagesAtom, current => change(normalizeImages(current ?? [])))
  await saveRecord($, { images })
}

async function markAllImages($: EngineInterface, isMarked: boolean) {
  await setImages($, rows => rows.map(({ isMarked: _, ...row }) => (isMarked ? { ...row, isMarked: true } : row)))
}

async function toggleImage($: EngineInterface, uuid: string) {
  await setImages($, rows =>
    rows.map(row => {
      if (row.uuid !== uuid) return row
      const { isMarked, ...rest } = row
      return isMarked ? rest : { ...rest, isMarked: true as const }
    }),
  )
}

// Whether a prune has something to do: turns marked, or images to take out.
async function hasPending($: EngineInterface) {
  const marks = (await read($, marksAtom)) ?? []
  return marks.length > 0 || (await readImages($)).some(row => row.isMarked)
}

// /compact can only start between turns, as a command of its own: queued once
// the hook that asks has returned. `then` runs after it, whatever came of it.
function startPrune($: EngineInterface, description: string, then?: () => Promise<unknown>) {
  $.clock.after(0, async () => {
    await $.command.run({ command: 'compact', args: `${PRUNE_TAG} ${description}`.trim() }).catch(error => {
      $.ui.toast(`/prune não começou (${error}). Mande /compact ${PRUNE_TAG}`)
    })
    // The pane last drew while the compaction was still laying its rows down
    // (the marks clear inside it), and they keep landing after the command
    // resolves: draw it again once the list ends with all it left.
    for (let tries = 0; tries < 20; tries++) {
      if (endsWithAnchor(await $.session.messages(), (await read($, liveAnchorAtom)) ?? null)) break
      await $.clock.sleep(250)
    }
    $.ui.invalidate('ui.render')
    await then?.()
  })
}

// The cold cache's prune runs on its own while the conversation sits idle,
// so the next message goes out on the pruned conversation whatever it carries
// (images and files included). Tried once per cold spell: marks a prune could
// not place stay pending and must not start it again each minute.
let idlePruneFor: number | null | undefined

async function pruneWhenIdle($: EngineInterface) {
  const lastRequestAt = (await read($, meter))?.lastRequestAt
  if (lastRequestAt === undefined || idlePruneFor === lastRequestAt) return
  if (!shouldAutoPrune(await hasPending($), await readCache($))) return
  idlePruneFor = lastRequestAt
  startPrune($, '')
}

// A compaction moves the context fill with no request made: the cache stays
// as cold as it was until the next response.
let isPrunedSinceResponse = false

// Turns as the person counts them: the commands a cut takes along are not.
function countTurns(cut: readonly { isCommand: boolean }[]) {
  return cut.filter(turn => !turn.isCommand).length
}

async function readCache($: EngineInterface) {
  const current = await read($, meter)
  return current ? cacheState(current.lastRequestAt, await $.clock.now()) : null
}

// What the person typed: the terminal's composer, or the desktop app's, which
// hosts the session through the SDK.
function isTyped(origin: PromptOrigin) {
  return origin.kind === 'composer' || origin.kind === 'sdk'
}

// The /prune pane: the turns, their images, and what a prune would cost.
async function drawPane($: EngineInterface, e: ResolveInput) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const messages = await liveMessages($)
  const marks = (await read($, marksAtom)) ?? []
  const { cut: markedCut, found } = matchMarks(messages, marks)
  const markBy = new Map([...found].map(([mark, turn]) => [turn.index, mark.by === 'claude' ? '[C]' : '[x]']))
  const allImages = await readImages($)
  const { turns, byTurn, loose } = await weighTurns($, messages)
  const listed = turns.filter(turn => !turn.isCommand).slice(-PANE_ROWS)
  const byIndex = new Map(turns.map(turn => [turn.index, turn]))
  const cut = markedCut.map(turn => byIndex.get(turn.index) ?? turn)
  const cutAt = new Set(cut.map(turn => turn.index))
  // Images of a turn marked whole go with it: not counted twice.
  const imageLeft = (rows: readonly ImageRow[], index: number) => (cutAt.has(index) ? [] : rows)
  const markedImages = [...[...byTurn].flatMap(([index, rows]) => imageLeft(rows, index)), ...loose].filter(
    row => row.isMarked,
  )
  const imageRow = (row: ImageRow) => (
    <Button key={`image-${row.uuid}`} plain onPress={() => toggleImage($, row.uuid)}>
      {row.isMarked ? '[x]' : '[ ]'} {`~${formatTokens(row.tokens)}`.padStart(5)}{' '}
      <Text dimColor>
        {row.isLegacy
          ? '[print]'
          : row.fromTool
            ? '[print de ferramenta]'
          : row.count > 1
            ? `[${row.count} imagens anexadas]`
            : '[imagem anexada]'}
      </Text>
    </Button>
  )

  const toggle = (index: number, head: string) =>
    setMarks($, current => {
      // State hands back copies: each mark is matched again, by value.
      const others = current.filter(mark => matchMarks(messages, [mark]).cut[0]?.index !== index)
      return others.length < current.length
        ? others
        : [...current, { index, head, fromEnd: messages.length - index }]
    })

  // Marks by row uuid name rows the pane cannot see ($.session.messages
  // carries no uuids): counted apart.
  const onMessages = marks.filter(mark => mark.uuid !== undefined).length
  const hasMarks = cut.length + onMessages + markedImages.length > 0
  const cache = await readCache($)
  const rewritten = [
    (cut.length > 0 || markedImages.some(row => !loose.includes(row))) &&
      `~${formatTokens(rewrittenTokens(turns, cut, byTurn))} depois do 1º corte`,
    markedImages.some(row => loose.includes(row)) && 'o que vem depois do print sem turno',
  ].filter(Boolean)
  const cacheLine = !hasMarks
    ? 'Marque os turnos ou os prints a remover.'
    : cache?.isWarm
      ? `Cache quente (${cache.minutesLeft} min): podar agora regrava ${rewritten.join(' e ') || 'o que vem depois do 1º corte'} a 2x; o que vem antes continua no cache. Deixe marcado: a poda roda sozinha na primeira mensagem depois que esfriar.`
      : 'Cache frio: a próxima mensagem regrava tudo de qualquer jeito, podar não custa nada a mais.'

  return (
    <Box flexDirection="column">
      {listed.flatMap(turn => [
        ...imageLeft(byTurn.get(turn.index) ?? [], turn.index).map(imageRow),
        <Button key={`turn-${turn.index}`} plain onPress={() => toggle(turn.index, turn.head)}>
          {markBy.get(turn.index) ?? '[ ]'} {`${turn.isMeasured ? '' : '~'}${formatTokens(turn.tokens)}`.padStart(5)}{' '}
          <Text dimColor>{turn.preview}</Text>
        </Button>,
      ])}
      {loose.length > 0 && <Text dimColor>Prints sem turno identificado:</Text>}
      {loose.map(imageRow)}
      <Text> </Text>
      {cut.length + markedImages.length > 0 && (
        <Text>
          {[
            cut.length > 0 && `${countTurns(cut)} turno(s)`,
            markedImages.length > 0 && `${markedImages.length} print(s)`,
          ]
            .filter(Boolean)
            .join(' e ')}{' '}
          marcado(s), ~
          {formatTokens(removedTokens(cut) + markedImages.reduce((sum, row) => sum + row.tokens, 0))} tokens a
          menos.
        </Text>
      )}
      {[...markBy.values()].includes('[C]') && (
        <Text dimColor>[C] = marcado pelo Claude; clique para desmarcar.</Text>
      )}
      {onMessages > 0 && <Text>{onMessages} turno(s) marcado(s) fora desta lista.</Text>}
      {allImages.length > 0 && (
        <Text dimColor>Um print marcado sai sozinho; o texto da mensagem fica, com [print removido] no lugar.</Text>
      )}
      <Text dimColor>{cacheLine}</Text>
      {hasMarks && (
        <Box flexDirection="row" gap={2}>
          <Button key="prune" onPress={() => startPrune($, '')}>
            Podar Agora
          </Button>
          <Button
            key="clear"
            onPress={async () => {
              await setMarks($, () => [])
              await markAllImages($, false)
            }}
          >
            Desmarcar Todos
          </Button>
        </Box>
      )}
      <Text dimColor>Tokens medidos ao fim de cada turno; ~ estimado (texto pelo tamanho, imagens pela resolução).</Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { context } = await $.session.usage()
    const kept = await read($, meter)
    const path = await dataPath($)
    const stored = path ? (await readRecords($, path))[await $.session.id()] : undefined
    const lastRequestAt = kept?.lastRequestAt ?? stored?.lastRequestAt ?? null
    await patchMeter($, { tokens: context.tokens, window: context.window, lastRequestAt })
    if (stored?.marks?.length) await update($, marksAtom, current => (current?.length ? current : stored.marks!))
    if (stored?.images?.length) await update($, imagesAtom, current => (current?.length ? current : stored.images!))
    if (stored?.turnTokens) await update($, turnTokensAtom, current => ({ ...stored.turnTokens, ...current }))
    if (stored?.boundary !== undefined) await update($, boundaryAtom, current => current ?? stored.boundary!)
    await showStatus($)
    $.clock.every(REDRAW_MS, async () => {
      await showStatus($)
      await pruneWhenIdle($)
    })
    // A conversation opened after it went cold prunes once it has settled.
    $.clock.after(IDLE_PRUNE_DELAY_MS, () => pruneWhenIdle($))
    await $.command.register({
      name: 'prune',
      description: 'Open the list of turns to mark for removal from the context',
    })
    await $.tool.register({
      name: MARK_TOOL,
      description: MARK_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'mark', 'unmark'] },
          turns: { type: 'array', items: { type: 'integer' }, description: 'Turn numbers (#n) from the latest list' },
        },
        required: ['action'],
      },
    })
    return next(e)
  })

  // A surface that joins after the status was set may not have it: set it
  // again for it (the desktop app attaches after session.start).
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    await showStatus($)
    return joined
  })

  // A new fill means a response just came back: the cache was renewed now.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const previous = await read($, meter)
      const isNewResponse = e.context.tokens !== undefined && e.context.tokens !== previous?.tokens
      // A measurement after a prune, before any response, is no response:
      // the estimate stands.
      if (!isPrunedSinceResponse) await patchMeter($, { tokens: e.context.tokens, window: e.context.window, isEstimate: undefined })
      if (isNewResponse && !isPrunedSinceResponse) await renewCache($)
    }
    return next(e)
  })

  // Rows that carry an image, by uuid (the compaction's handle), so a prune
  // can find them: session.compact's messages hold no blocks. Each keeps the
  // prompt of its turn (a tool's image, the latest prompt's) for the pane.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId || stored.deny) return stored
    const row = describeRow(stored.message)
    if (row.promptKey !== undefined) await update($, promptKeyAtom, () => row.promptKey!)
    if (row.images) {
      const key = row.promptKey ?? ((await read($, promptKeyAtom)) || '')
      await setImages($, current => [...current, { uuid: stored.uuid, key, ...row.images! }])
      $.ui.invalidate('ui.render')
    }
    return stored
  })

  // The end of a main-loop turn that made requests is the latest renewal.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) {
      if (isPrunedSinceResponse) {
        // The measurements this turn made were skipped: take the latest.
        isPrunedSinceResponse = false
        const { context } = await $.session.usage()
        await patchMeter($, { tokens: context.tokens, window: context.window, isEstimate: undefined })
      }
      await renewCache($)
      await measureTurnEnd($, e.answer)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    // The prune normally ran while idle (pruneWhenIdle). If a prompt beats it,
    // prune first and send the prompt again as the person's. A prompt with
    // images or files goes as it is (a plugin's prompt carries no media), and
    // the idle prune runs after its answer has gone cold again.
    if (isTyped(e.origin) && !e.attachments?.length && shouldAutoPrune(await hasPending($), await readCache($))) {
      const text = e.text
      startPrune($, '', () => $.prompt.submit({ text, asUser: true }))
      return { drop: 'context-prune: conversa fria, podando o que estava marcado antes de enviar' }
    }

    const current = await read($, meter)
    const note = current && modelNote(current)
    if (!note) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // /prune opens the list; the pane's Podar applies the marks.
  on('command.run', { command: 'prune' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    return { text: 'Painel aberto: marque os turnos e aperte Podar, ou deixe marcado para a poda rodar quando a conversa esfriar.' }
  })

  on('tool.call', { tool: MARK_TOOL_ID }, async ($, e) => {
    const { action, turns = [] } = e as unknown as { action?: string; turns?: number[] }
    const messages = await liveMessages($)
    let refused: string[] = []
    if (action === 'mark' || action === 'unmark') {
      const applied = applyToolMarks(messages, (await read($, marksAtom)) ?? [], action, turns)
      refused = applied.refused
      await setMarks($, () => applied.marks)
      $.ui.invalidate('ui.render')
    } else if (action !== 'list') {
      return { deny: `action must be list, mark or unmark, not ${action}` }
    }
    const cache = await readCache($)
    const when = cache?.isWarm
      ? `O cache esfria em ${cache.minutesLeft} min; a poda roda sozinha quando a conversa completar 1 h parada.`
      : 'O cache está frio: a poda roda sozinha em até 1 min.'
    const { turns: weighed } = await weighTurns($, messages)
    const text = [toolListing(messages, (await read($, marksAtom)) ?? [], weighed), ...refused, when].join('\n')
    return { result: text }
  })

  // /prune's own compaction: the marked turns out, the images too when asked,
  // nothing summarized. Any other compaction goes on as the engine does it.
  on('session.compact', async ($, e, next) => {
    const description = pruneDescription(e.instructions)
    if (e.agentId || e.trigger === 'precompute') return next(e)
    // Whoever compacts, what it leaves is the conversation from now on.
    const markLiveStart = (left: readonly { text: string }[]) => update($, liveAnchorAtom, () => anchorOf(left))
    // The rows a compaction keeps come back through session.append, with new
    // uuids: the image rows are recorded again from there.
    if (description === undefined) {
      const before = await readImages($)
      await setImages($, () => [])
      const result = await next(e)
      if (result.skip) await setImages($, current => [...before, ...current])
      else {
        await markLiveStart(result.messages)
        await setBoundary($, null)
      }
      return result
    }
    const { cut, missed } = matchMarks(e.messages, (await read($, marksAtom)) ?? [])
    const readImagesBefore = readImages($)
    const imageRows = new Set((await readImagesBefore).filter(row => row.isMarked).map(row => row.uuid))
    const images = countImages(e.messages, imageRows)
    if (cut.length === 0 && images === 0) {
      const lost = missed.length ? `: ${missed.length} marca(s) não encontrada(s) na conversa` : ''
      return { skip: `context-prune: nada a podar${lost}` }
    }
    // Weighed before the rows change: the request form still holds the cut turns.
    const weighed = new Map((await weighTurns($, e.messages)).turns.map(turn => [turn.index, turn]))
    const cutWeighed = cut.map(turn => weighed.get(turn.index) ?? turn)
    const messages = pruneMessages(stripImages(e.messages, imageRows), cut, description)
    await setImages($, () => [])
    // A mark that found no turn stays, and is said: it is never dropped quietly.
    await setMarks($, () => missed)
    const done = [
      missed.length > 0 && `${missed.length} marca(s) não encontrada(s), mantida(s)`,
      cut.length > 0 && `${countTurns(cut)} turno(s) removido(s), ~${formatTokens(removedTokens(cutWeighed))} tokens`,
      images > 0 && `${images} print(s) removido(s)`,
    ].filter(Boolean)
    $.ui.toast(`${done.join('; ')}`)
    await markLiveStart(messages)
    await setBoundary($, null)
    isPrunedSinceResponse = true
    // No request measures the pruned context until the next response: the
    // model's note carries the mod's estimate meanwhile, not the old size.
    const strippedTokens = (await readImagesBefore).filter(row => imageRows.has(row.uuid)).reduce((sum, row) => sum + row.tokens, 0)
    await update($, meter, current =>
      current?.tokens === undefined
        ? current
        : { ...current, tokens: Math.max(0, current.tokens - removedTokens(cutWeighed) - strippedTokens), isEstimate: true },
    )
    return { messages }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))
}

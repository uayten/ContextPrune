import type { Lang, PruneNote } from '../types'

export type { Lang }

// Every text the person reads, in each language the plugin speaks. What the
// model alone reads (the prune_marks tool and its answers, the context note)
// stays in English.

export const LANGS: readonly Lang[] = ['en', 'pt']
export const DEFAULT_LANG: Lang = 'en'

export function isLang(value: unknown): value is Lang {
  return LANGS.includes(value as Lang)
}

// Which language `/prune <args>` names, if any.
export function langArg(args: string): Lang | undefined {
  const word = args.trim().toLowerCase()
  return isLang(word) ? word : undefined
}

const en = {
  langName: 'English',
  langSet: 'Context Prune is now in English.',

  statusWarm: (minutes: number) => `Conversation is warm - ${minutes} min left`,
  statusCold: 'Conversation is cold - /prune recommended',

  paneTitle: 'Prune context',
  paneOpened:
    'Pane open: mark the turns and press Prune Now, or leave them marked for the prune to run once the conversation goes cold.',
  pruneFailed: (error: unknown, tag: string) => `/prune did not start (${error}). Send /compact ${tag}`,
  autoPruneDrop: 'context-prune: the conversation is cold, pruning what was marked before sending',
  pruneBlocked:
    "Prune off: this organization manages Claude Code and keeps /compact from installed plugins, so Claude Code would write a summary instead. An administrator can list context-prune in the managed settings.",

  turns: (n: number) => (n === 1 ? '1 turn' : `${n} turns`),
  images: (n: number) => (n === 1 ? '1 screenshot' : `${n} screenshots`),
  and: ' and ',

  imageLegacy: '[screenshot]',
  imageFromTool: '[tool screenshot]',
  imagesAttached: (n: number) => (n === 1 ? '[image attached]' : `[${n} images attached]`),
  looseHeader: 'Screenshots with no turn found:',

  summaryWarm: (minutes: number) => `Cache warm · ${minutes} min`,
  summaryCold: 'Cache cold',
  summaryContext: (tokens: string, window: string) => `context ${tokens} / ${window}`,
  barAlt: (tokens: string, marked: string) => `Context ${tokens}, of which ${marked} marked`,
  markHint: 'Mark the turns or screenshots to remove.',
  rewrittenAfterCut: (tokens: string) => `${tokens} after the first cut`,
  afterLoose: 'what comes after the screenshot with no turn',
  firstCut: 'what comes after the first cut',
  cacheWarm: (minutes: number, what: string) =>
    `Cache warm (${minutes} min): pruning now writes ${what} to the cache again at 2x; what comes before stays cached. Leave it marked: the prune runs on its own once the conversation has sat an hour idle.`,
  cacheCold: 'Cache cold: the next message writes everything again anyway, so pruning costs nothing extra.',
  marked: (what: string, tokens: string) => `Marked: ${what}, ~${tokens} fewer tokens.`,
  claudeLegend: '[C] = marked by Claude; click to unmark.',
  markedOffList: (turns: string) => `Marked outside this list: ${turns}.`,
  imageNote: (removed: string) => `A marked screenshot goes alone; the message's text stays, with ${removed} in its place.`,
  pruneNow: 'Prune Now',
  clearAll: 'Unmark All',
  tokensNote: 'Tokens measured at the end of each turn; ~ estimated (text by length, images by resolution).',
  languageButton: '⚙',
  languageHint: 'Language (also /prune en or /prune pt):',

  nothingToPrune: 'context-prune: nothing to prune',
  marksMissed: (n: number) => (n === 1 ? '1 mark not found, kept' : `${n} marks not found, kept`),
  removedToast: (what: string) => `Removed: ${what}`,
  turnsTokens: (turns: string, tokens: string) => `${turns} (~${tokens} tokens)`,

  // What the model reads in place of what went.
  // Who the removed turns were from, as lines written before the count alone.
  removedWho: "user prompts and Claude's replies",
  removedLine: (count: number, note?: PruneNote) =>
    `[${count} ${count === 1 ? 'turn' : 'turns'} removed with /prune${note ? `. ${note.by === 'claude' ? "Claude's note" : 'Note'}: ${note.text}` : ''}]`,
  removedCommands: '[commands removed with /prune]',
  noteLabel: (note: PruneNote) =>
    note.by === 'claude' ? "Claude's note, left in place of the turns:" : 'Note, left in place of the turns:',
  deleteNote: 'Delete note',
  mediaRemoved: '[screenshot removed]',
}

export type Texts = typeof en

const pt: Texts = {
  langName: 'Português',
  langSet: 'O Context Prune agora está em português.',

  statusWarm: minutes => `Conversa está quente - ${minutes} min restantes`,
  statusCold: 'Conversa está fria - /prune recomendado',

  paneTitle: 'Podar contexto',
  paneOpened:
    'Painel aberto: marque os turnos e aperte Podar Agora, ou deixe marcado para a poda rodar quando a conversa esfriar.',
  pruneFailed: (error, tag) => `/prune não começou (${error}). Mande /compact ${tag}`,
  autoPruneDrop: 'context-prune: conversa fria, podando o que estava marcado antes de enviar',
  pruneBlocked:
    'Poda desligada: esta organização gerencia o Claude Code e não passa o /compact a plugins instalados, então o Claude Code faria um resumo no lugar. Um administrador pode listar o context-prune nas configurações gerenciadas.',

  turns: n => (n === 1 ? '1 turno' : `${n} turnos`),
  images: n => (n === 1 ? '1 print' : `${n} prints`),
  and: ' e ',

  imageLegacy: '[print]',
  imageFromTool: '[print de ferramenta]',
  imagesAttached: n => (n === 1 ? '[imagem anexada]' : `[${n} imagens anexadas]`),
  looseHeader: 'Prints sem turno identificado:',

  summaryWarm: minutes => `Cache quente · ${minutes} min`,
  summaryCold: 'Cache frio',
  summaryContext: (tokens, window) => `contexto ${tokens} / ${window}`,
  barAlt: (tokens, marked) => `Contexto ${tokens}, dos quais ${marked} marcados`,
  markHint: 'Marque os turnos ou os prints a remover.',
  rewrittenAfterCut: tokens => `${tokens} depois do 1º corte`,
  afterLoose: 'o que vem depois do print sem turno',
  firstCut: 'o que vem depois do 1º corte',
  cacheWarm: (minutes, what) =>
    `Cache quente (${minutes} min): podar agora regrava ${what} a 2x; o que vem antes continua no cache. Deixe marcado: a poda roda sozinha quando a conversa completar 1 h parada.`,
  cacheCold: 'Cache frio: a próxima mensagem regrava tudo de qualquer jeito, podar não custa nada a mais.',
  marked: (what, tokens) => `Marcados: ${what}, ~${tokens} tokens a menos.`,
  claudeLegend: '[C] = marcado pelo Claude; clique para desmarcar.',
  markedOffList: turns => `Marcados fora desta lista: ${turns}.`,
  imageNote: removed => `Um print marcado sai sozinho; o texto da mensagem fica, com ${removed} no lugar.`,
  pruneNow: 'Podar Agora',
  clearAll: 'Desmarcar Todos',
  tokensNote: 'Tokens medidos ao fim de cada turno; ~ estimado (texto pelo tamanho, imagens pela resolução).',
  languageButton: '⚙',
  languageHint: 'Idioma (também /prune en ou /prune pt):',

  nothingToPrune: 'context-prune: nada a podar',
  marksMissed: n => (n === 1 ? '1 marca não encontrada, mantida' : `${n} marcas não encontradas, mantidas`),
  removedToast: what => `Removidos: ${what}`,
  turnsTokens: (turns, tokens) => `${turns} (~${tokens} tokens)`,

  removedWho: 'pedidos do usuário e respostas do Claude',
  removedLine: (count, note) =>
    `[${count} ${count === 1 ? 'turno removido' : 'turnos removidos'} com /prune${note ? `. ${note.by === 'claude' ? 'Nota do Claude' : 'Nota'}: ${note.text}` : ''}]`,
  removedCommands: '[comandos removidos com /prune]',
  noteLabel: note => (note.by === 'claude' ? 'Nota do Claude, que fica no lugar dos turnos:' : 'Nota, que fica no lugar dos turnos:'),
  deleteNote: 'Apagar nota',
  mediaRemoved: '[print removido]',
}

export const TEXTS: Record<Lang, Texts> = { en, pt }

export function textsFor(lang: Lang): Texts {
  return TEXTS[lang] ?? TEXTS[DEFAULT_LANG]
}

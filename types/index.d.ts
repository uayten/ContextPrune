/** The language of what the person reads: the pane, the status, the notices. */
export type Lang = 'en' | 'pt'

export type Meter = {
  /** Input tokens of the last response (cached + uncached); absent before one. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** When the last request to the model ended, ms since the epoch; null before one. */
  lastRequestAt: number | null
  /** True after a prune, until the next response: `tokens` is the mod's estimate. */
  isEstimate?: boolean
}

/**
 * A turn the person marked for /prune: by its prompt row's uuid (the ✕ on the
 * message), or by position in the pane's list.
 */
export type Mark = {
  /** The prompt row's uuid, when marked on the message itself. */
  uuid?: string
  /** The prompt's position in the conversation's messages. */
  index?: number
  /** The prompt's first characters, to check the position still holds it. */
  head?: string
  /** Messages from the prompt to the end when marked: the position that survives rows prepended to the list. */
  fromEnd?: number
  /** Who marked it: `claude` through its tool; absent, the person in the pane. */
  by?: 'claude'
}

export type LiveAnchor = {
  /** The first message's text after the compaction (the opening prompt). */
  head: string
  /** How many messages the compaction left. */
  count: number
}

export type ImageRow = {
  /** The row's uuid: the compaction's handle for it. */
  uuid: string
  /** The prompt of the turn it belongs to, as the pane reads it; '' when unknown. */
  key: string
  /** The row's images, estimated by their size. */
  tokens: number
  /** How many images the row holds. */
  count: number
  /** The row is a tool's result, not a prompt. */
  fromTool?: true
  /** Marked for removal. */
  isMarked?: true
  /** Recorded before rows kept their turn and size: placed apart, weighed as the largest. */
  isLegacy?: true
}

declare module 'claude-code' {
  interface PluginState {
    'context-prune': {
      meter: Meter | null
      /** The language chosen with /prune en|pt or the pane's ⚙; kept in preferences.json. */
      language: Lang
      marks: Mark[]
      /**
       * Rows that carry an image (a pasted print, a tool's screenshot); a
       * plain uuid is the shape written before the rows carried more.
       */
      images: (ImageRow | string)[]
      /** The latest prompt's key (ImageRow.key), for the images a tool returns. */
      promptKey: string
      /** Each turn's measured weight in tokens, by its prompt's key. */
      turnTokens: Record<string, number>
      /**
       * Where the last turn ended, in tokens (its context plus its answer):
       * the next turn's weight is measured from here. Null after a compaction.
       */
      boundary: number | null
      /**
       * The last compaction's result, to find where the conversation the model
       * reads starts in `$.session.messages()`: after a compaction the live
       * list may keep the rows it replaced ahead of the new ones (until the
       * process restarts). Null before any.
       */
      liveAnchor: LiveAnchor | null
    }
  }
}

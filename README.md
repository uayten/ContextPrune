# Context Prune

[Português](README.pt-BR.md) · **English**

A Claude Code plugin (desktop app) for resuming long conversations with fewer
tokens once the conversation has gone cold. It removes from the history the
turns the conversation no longer needs, for example:

- installing and setting up a program (an MCP server that only worked on the
  third try);
- debugging a one-off bug that has since been fixed;
- probes, throwaway tests and confirmations like "done" or "it works";
- attempts that were replaced by another solution;
- screenshots that were already read and no longer need to ride along on
  every request.

A short line saying what went takes their place, with no summary and no model
call. Both you and Claude mark the turns to remove. The prune runs on its own
once the conversation has sat an hour idle: the prompt cache has expired, and
the next message would write the whole conversation again anyway.

- [What it does](#what-it-does)
  - [Cache status](#cache-status)
  - [The /prune pane](#the-prune-pane)
  - [Screenshots](#screenshots)
  - [Claude's marks](#claudes-marks)
  - [Automatic prune](#automatic-prune)
  - [What pruning costs](#what-pruning-costs)
  - [Language](#language)
- [Install](#install)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

## What it does

### Cache status

Beside the model picker you see one of these:

- `Conversation is warm - N min left`: the last response came less than an
  hour ago, and the next message reads the conversation from the cache
  (cheap).
- `Conversation is cold - /prune recommended`: an hour has passed. The next
  message writes the whole conversation again, so this is the time to prune at
  no extra cost.

With each prompt, the model gets one line with the context size
(`context-prune: context 355k / 1M (35%) tokens.`). The cache state is left
out, because the choice to prune is yours.

### The /prune pane

`/prune` opens the **Prune context** pane, with one item per turn. A turn is
your prompt and everything that came in reply: the text, the model's thinking,
and the tools with their results. Each item shows its weight in tokens and the
start of the prompt.

- Clicking an item marks or unmarks it. `[x]` is your mark; `[C]`, Claude's.
- **Prune Now** applies the marks right away. **Unmark All** clears them.
- The marked turns become a single line, and that line is what the model
  reads:
  `[removed: 5 turns (user prompts and Claude's replies): ok, run any command… | how do I choose… | …]`.
  Marked turns that look adjacent in the pane become one line. The hidden
  commands between them, like `/prune` and its reply, go with them. Pruning a
  `[removed: …]` line again adds up the count.
- A weight with no `~` was measured when the turn ended. With `~`, it is
  estimated (text and thinking by length, images by resolution).
- Marks are saved and survive a restart of Claude.

### Screenshots

Each image in the conversation (a pasted screenshot, or one a tool returned)
has its own line in the pane, just above the prompt it came with:

```
[ ] ~1.5k [image attached]
[ ]   448 I just sent a message with...
```

Marking the image removes only the image: the message's text stays, with
`[screenshot removed]` in its place. Marking the prompt removes the whole
turn, image included. A prompt that is only an image shows as a single item,
`[image attached]`.

### Claude's marks

Claude has a tool, `prune_marks`, to mark turns that are no longer useful,
such as settled setup, debugging, probes and test confirmations. The list of
turns and marks reaches Claude only when it uses the tool, not with every
message. Claude only unmarks its own marks; yours stay as you left them. Its
marks show as `[C]` in the pane, and you unmark whatever you want to keep.

### Automatic prune

Whatever is marked waits for the conversation to go cold. Once it has sat an
hour idle, the plugin prunes on its own and says how many turns and
screenshots went. The next message, whatever it is (text, screenshot or
attachment), already goes out with the pruned conversation.

With Claude closed, the prune runs a few seconds after you open the
conversation again. If a text message arrives before that, the plugin holds
it (the app says the prompt was blocked by a hook), prunes, and sends the text
again as yours.

### What pruning costs

The cache stores the conversation as a sequence. After a prune, what comes
before the first cut stays in the cache; what comes after is written again
with the next message. With the 1-hour cache, writing costs 2x and reading
costs 0.1x.

- **Cold conversation:** the next message writes everything anyway. Pruning
  only shrinks what is written.
- **Warm conversation:** pruning now writes what comes after the first cut
  again, at 2x. It only pays off if the conversation will go on for many
  requests, or if the context is close to the limit. The pane shows this
  figure before you press.

### Language

The plugin speaks English or Portuguese; English is the default. To switch,
send `/prune pt` or `/prune en`, or press the ⚙ at the top of the pane, to the
right of the bar. The choice applies to every conversation.

It changes what you read: the status, the pane, the notices, and the lines the
prune leaves (`[removed: …]` or `[removido: …]`, `[screenshot removed]` or
`[print removido]`). Lines already in the conversation stay as they were
written, and a later prune adds up their count in either language. What only
Claude reads (the marks tool) stays in English.

## Install

In a terminal running Claude Code, or in the desktop app, type:

```text
/plugin install context-prune --marketplace uayten/ContextPrune
```

In two steps, or on versions before 2.1.275:

```text
/plugin marketplace add uayten/ContextPrune
/plugin install context-prune@fofuxo-context-prune
```

Tested on the desktop app, version 2.1.299.

## How it works

A prune is a `/compact` the plugin answers itself (`session.compact`): it
hands back the conversation with the marked turns replaced by the
`[removed: …]` line, without calling the model. The messages that stay whole
remain in the cache.

| Part | Hook |
|---|---|
| Status and context size | `session.start`, `session.attach`, `session.measure`, `turn.complete`, `prompt.submit` |
| Record of each screenshot and its prompt | `session.append` |
| Measured weight of each turn | `turn.complete` (how much the context grew between the end of one turn and the end of the previous one) |
| Pane and language | `command.run` (`/prune`, `/prune en\|pt`) and `ui.render` (`Pane`) |
| Claude's marks | `$.tool.register` and `tool.call` (`mcp__context-prune__prune_marks`) |
| Prune | `session.compact`; the automatic one starts at `prompt.submit` |

Each conversation's data (time of the last response, marks, screenshots,
measured weights) is kept in
`~/.claude/plugins/data/context-prune/sessions.json`, outside the plugin
folder. Conversations idle for more than 30 days are dropped from the file.
The language is kept in `preferences.json`, in the same folder. See
[PRIVACY.md](PRIVACY.md).

## Known limitations

- The cache state is worked out with the 1-hour TTL. On account usage
  overage the cache drops to 5 minutes, and the plugin has no way to know.
- Turns are tied to their weights and screenshots by the start of the prompt.
  Prompts that start the same, like two "ok"s, may swap numbers.
- Turns from before real measuring stay estimated (`~`). The estimate uses
  the conversation in the form sent to the API, thinking included. The first
  turn after a prune is estimated too.
- An image's weight is read from the PNG header. Other formats count as the
  largest, 1.6k. When a turn's images are estimated above the turn's measured
  weight, the turn stays estimated (`~`).
- In organizations that manage Claude Code (Team and Enterprise plans with
  managed settings), Claude Code does not pass `session.compact` to plugins a
  person installs on their own. There the status, the pane and the marks
  work, but a prune would become an ordinary `/compact`, with a summary
  written by the model. So when there are managed settings that don't name
  `context-prune`, the plugin doesn't start a prune and says so in the pane.
  An administrator allows it by listing the plugin in those settings.
- If you open a cold conversation and send a screenshot or attachment in the
  first few seconds, before the prune runs, the message goes out unpruned.
  The prune waits for the conversation to go cold again.
- After editing the plugin, the change applies from the second message on.
  Sometimes the desktop app only loads it after restarting Claude.
- The "saved N tokens" the app shows after a prune is higher than the real
  figure: the app compares the whole context from before with only the
  messages that remain, without the system prompt and the tools. The plugin
  cannot correct that number; the real size shows with the next response.

## Development

- `hooks/register.tsx`: the hooks and the pane.
- `hooks/lib.ts`: the pure logic (turns, marks, prune, screenshots, weights),
  tested in `hooks/lib.test.ts`.
- `hooks/i18n.ts`: the texts in each language.
- `types/index.d.ts`: the `$.state` contract.

To try it without installing, load the folder in a session:

```bash
claude --plugin-dir .
```

In the desktop app, which does not take the option, put the folder in
`CLAUDE_CODE_PLUGIN_DIRS`, in the `env` block of `~/.claude/settings.json`.
Don't keep the installed version enabled at the same time: the two copies
run every hook twice.

To validate and run the tests:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests cover the logic, not how the pane is drawn: an error in the pane
shows as "Nothing to show yet".

## License

[MIT](LICENSE)

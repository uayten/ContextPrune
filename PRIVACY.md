# Privacy Policy

Context Prune is a Claude Code plugin that runs only on your computer. It
collects nothing and sends nothing anywhere.

## What it reads

- **The current conversation**, through Claude Code's own plugin interface, to
  list its turns and screenshots in the `/prune` pane and to weigh them in
  tokens. Nothing is read from other conversations.
- **Its own data files** in `~/.claude/plugins/data/context-prune/`.

## What it writes

- **`sessions.json`** in that folder: for each conversation, when the last
  response came, the turns and screenshots marked for removal, and the
  measured weight of each turn, keyed by the start of its prompt. A
  conversation idle for more than 30 days is dropped from the file.
- **`preferences.json`** in that folder: the language you chose.
- **The conversation itself**, when a prune runs: the marked turns are
  replaced by a short `[removed: …]` line and marked screenshots by
  `[screenshot removed]`. The original messages stay in the conversation's
  transcript file on your disk, as with `/compact`.

## What it sends

Nothing. The plugin makes no network requests, calls no model (a prune is
done without a summary), and has no analytics or telemetry. What reaches
Anthropic is what Claude Code already sends: the conversation, smaller after a
prune, and one line per prompt with the context size.

## Questions

Open an issue at <https://github.com/uayten/ContextPrune/issues>.

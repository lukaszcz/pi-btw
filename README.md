# pi-btw

A [pi](https://github.com/badlogic/pi-mono) extension that lets you ask side-questions without those Q&A turns polluting your main conversation context.

## Usage

```
/btw <question>
```

A floating overlay panel opens. It's seeded with a **read-only snapshot** of the current main conversation so the model has full context to answer your question. The panel supports a full back-and-forth exchange. When you close it, **nothing is written back to the main session** — the main context remains exactly as it was before you typed `/btw`.

### Read-only tools

The side conversation has access to **read-only tools** — `read`, `grep`, `find`, and `ls` — so the model can look things up in your codebase to answer your question. The model runs a full agent loop: it can make multiple tool calls in sequence, see their results, and reason further before giving you a final answer.

Write-oriented tools (`bash`, `write`, `edit`, etc.) are explicitly blocked. If the model tries to call a known-but-disallowed tool it gets a targeted error message; truly unknown tools get a generic "not available" response. Either way, your project is never modified.

This means you can ask things like _"what does the `handleInput` method do?"_ or _"find all usages of `convertToLlm`"_ and the model will browse your files to give you an informed answer — without any risk of modifying your project.

### Keyboard shortcuts inside the panel

| Key | Action |
|-----|--------|
| `Enter` | Send your question / follow-up |
| `Shift+Enter` | Insert a newline in the editor |
| `Esc` | Cancel the current request if thinking, otherwise close the panel |
| `Ctrl+C` | Copy the last assistant message to clipboard |
| `↑` / `↓` | Scroll the log area (1 line) |
| `PageUp` / `PageDown` | Scroll the log area (10 lines) |

## Installation

Install as a pi package:

```bash
pi install pi-btw
```

Or copy `btw.ts` to your pi extensions directory manually:

```bash
cp btw.ts ~/.pi/agent/extensions/btw.ts
```

Or, from inside a project, place it in `.pi/extensions/btw.ts`.

You can also point pi at it directly for testing:

```bash
pi -e ./pi-btw/btw.ts
```

## How it works

1. When you run `/btw <question>`, the extension:
   - Reads the current session branch via `ctx.sessionManager.getBranch()`
   - Converts those messages to LLM format with `convertToLlm()`
   - Opens a floating overlay using `ctx.ui.custom()` with `overlay: true` (90% width/height, centred)

2. Inside the overlay, every LLM call is:
   - Passed `contextMessages` (the snapshot) + `sideMessages` (this panel's history)
   - Given read-only tools (`read`, `grep`, `find`, `ls`) created via `createReadOnlyTools()` from pi's SDK
   - Made via `complete()` from `@mariozechner/pi-ai` directly — no session involvement
   - Run in an agent loop: the model can request tools, see results, and continue until it produces a final text response or is aborted

3. The main session's `appendMessage`, `sendMessage`, etc. are **never called**.
   The overlay is purely display-side; closing it leaves zero traces in the main session.

## Requirements

- pi coding agent (any recent version)
- An API key for your current model (same one the main session uses)

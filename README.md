# pi-btw

A [pi](https://github.com/badlogic/pi-mono) extension that lets you ask side-questions without those Q&A turns polluting your main conversation context.

## Usage

```
/btw <question>
```

A floating overlay panel opens. It's seeded with a **read-only snapshot** of the current main conversation so the model has full context to answer your question. The panel supports a full back-and-forth exchange. When you close it, **nothing is written back to the main session** — the main context remains exactly as it was before you typed `/btw`.

### Read-only tools

The side conversation has access to **read-only tools** — `read`, `grep`, `find`, and `ls` — so the model can look things up in your codebase to answer your question. Write-oriented tools (`bash`, `write`, `edit`, etc.) are explicitly blocked; if the model tries to call one it gets an error message telling it to stick to the read-only set.

This means you can ask things like _"what does the `handleInput` method do?"_ or _"find all usages of `convertToLlm`"_ and the model will browse your files to give you an informed answer — without any risk of modifying your project.

### Keyboard shortcuts inside the panel

| Key | Action |
|-----|--------|
| `Enter` | Send your question / follow-up |
| `Shift+Enter` | Insert a newline in the editor |
| `Esc` | Close the panel (aborts any in-flight request) |
| `Ctrl+C` | Cancel the current request (panel stays open) |

## Installation

Copy `btw.ts` to your pi extensions directory:

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
   - Opens a floating overlay using `ctx.ui.custom({ overlay: true })`

2. Inside the overlay, every LLM call is:
   - Passed `contextMessages` (the snapshot) + `sideMessages` (this panel's history)
   - Given read-only tools (`read`, `grep`, `find`, `ls`) created via `createReadOnlyTools()` from pi's SDK
   - Made via `complete()` from `@mariozechner/pi-ai` directly — no session involvement
   - Aborted cleanly when you press Esc

3. The main session's `appendMessage`, `sendMessage`, etc. are **never called**.
   The overlay is purely display-side; closing it leaves zero traces in the main session.

## Requirements

- pi coding agent (any recent version)
- An API key for your current model (same one the main session uses)

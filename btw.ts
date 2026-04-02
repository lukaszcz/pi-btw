/**
 * pi-btw — ask side-questions without polluting the main conversation
 *
 * Usage:
 *   /btw <question>
 *
 * Opens a floating overlay chat panel seeded with a snapshot of the current
 * main-conversation context.  You can have a full back-and-forth inside the
 * panel.  When you close it (Escape) nothing is written back to the main
 * session — the main context is untouched.
 */

import { complete } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { convertToLlm, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	Editor,
	type EditorTheme,
	type TUI,
	type Component,
} from "@mariozechner/pi-tui";
import type { Message, UserMessage, Model, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

/** The tool type returned by createReadOnlyTools — AgentTool with execute(). */
type ExecutableTool = ReturnType<typeof createReadOnlyTools>[number];

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Pull the current branch messages into LLM-compatible format. */
function buildContextMessages(branch: SessionEntry[]): Message[] {
	const messages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message as Message);
	return convertToLlm(messages);
}

// ─── Display message ──────────────────────────────────────────────────────────

interface ChatMessage {
	role: "user" | "assistant" | "tool";
	text: string;
}

// ─── BtwPanel ─────────────────────────────────────────────────────────────────

/**
 * Floating overlay panel that hosts the side-conversation.
 *
 * Layout:
 *   ╭── btw · <model> ───────────────────╮
 *   │ You ─────────────────────────────  │  ← scrollable log area
 *   │  <user text>                        │
 *   │ btw ─────────────────────────────  │
 *   │  <assistant text>                   │
 *   │ [thinking...]                       │
 *   │ ↑↓ scroll · N/M lines              │  ← scroll hint (when needed)
 *   ├─────────────────────────────────────┤
 *   │ <editor for next question>          │
 *   │ Enter · send   Esc · close          │
 *   ╰─────────────────────────────────────╯
 */
class BtwPanel implements Component {
	// Messages already in the main session at panel-open time
	private readonly contextMessages: Message[];
	// New messages accumulated only inside this panel
	private readonly sideMessages: Message[] = [];
	// Display log
	private readonly log: ChatMessage[] = [];

	private thinking = false;
	private thinkingDots = 0;
	private thinkingTimer: ReturnType<typeof setInterval> | null = null;
	private errorText = "";

	private abortController: AbortController | null = null;

	private editor: Editor;

	// Scroll state: how many lines from the top of the log we have scrolled
	private scrollOffset = 0;

	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any, // Theme passed by ctx.ui.custom callback
		_keybindings: any,
		private readonly done: (result: null) => void,
		contextMessages: Message[],
		firstQuestion: string,
		private readonly modelShortId: string,
		private readonly model: Model<any>,
		private readonly apiKey: string,
		private readonly apiHeaders: Record<string, string> | undefined,
		private readonly systemPrompt: string,
		private readonly agentTools: ExecutableTool[],
		private readonly disallowedToolNames: Set<string>,
	) {
		this.contextMessages = contextMessages;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => this.theme.fg("border", s),
			selectList: {
				selectedPrefix: (t: string) => this.theme.fg("accent", t),
				selectedText: (t: string) => this.theme.fg("accent", t),
				description: (t: string) => this.theme.fg("muted", t),
				scrollInfo: (t: string) => this.theme.fg("dim", t),
				noMatch: (t: string) => this.theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			this.editor.setText("");
			this.sendQuestion(trimmed);
		};

		// Inject a preamble so the model understands the side-conversation context
		const availableNames = this.agentTools.map((t) => t.name).join(", ");
		this.sideMessages.push({
			role: "user",
			content: [{
				type: "text",
				text: `[This is a side conversation. The user is asking quick questions alongside the main conversation. ` +
					`Only read-only tools are available here (${availableNames}). ` +
					`Do not use tools that modify the filesystem such as bash, write, or edit — they will fail.]`,
			}],
			timestamp: Date.now(),
		});

		// Start with the initial question from the /btw command
		this.sendQuestion(firstQuestion);
	}

	// ── Sending ──────────────────────────────────────────────────────────────

	/** Convert AgentTool[] to Tool[] for the LLM context (schema only, no execute). */
	private get toolSchemas(): Tool[] {
		return this.agentTools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	private sendQuestion(text: string): void {
		if (this.thinking) return;

		this.log.push({ role: "user", text });
		// Auto-scroll to bottom whenever a new message is added
		this.scrollToBottom();
		this.invalidate();

		const userMsg: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		this.sideMessages.push(userMsg);

		this.startThinking();
		this.errorText = "";

		this.abortController = new AbortController();
		this.runAgentLoop();
	}

	/**
	 * Run the agent loop: call the LLM, execute any tool calls, repeat until
	 * the LLM stops requesting tools or an error/abort occurs.
	 */
	private async runAgentLoop(): Promise<void> {
		try {
			while (true) {
				if (this.abortController?.signal.aborted) break;

				const messages: Message[] = [...this.contextMessages, ...this.sideMessages];
				const tools = this.agentTools.length > 0 ? this.toolSchemas : undefined;

				const response = await complete(
					this.model,
					{ systemPrompt: this.systemPrompt, messages, tools },
					{ apiKey: this.apiKey, headers: this.apiHeaders, signal: this.abortController!.signal },
				);

				if (response.stopReason === "aborted") {
					this.stopThinking();
					this.invalidate();
					this.tui.requestRender();
					return;
				}

				// Persist the assistant message in side context
				this.sideMessages.push(response);

				// Extract text content for display
				const replyText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				if (replyText) {
					this.log.push({ role: "assistant", text: replyText });
					this.scrollToBottom();
					this.invalidate();
					this.tui.requestRender();
				}

				// If the LLM wants to use tools, execute them
				if (response.stopReason === "toolUse") {
					const toolCalls = response.content.filter(
						(c): c is ToolCall => c.type === "toolCall",
					);

					for (const tc of toolCalls) {
						if (this.abortController?.signal.aborted) break;

						const tool = this.agentTools.find((t) => t.name === tc.name);
						if (!tool) {
							// Distinguish known-but-disallowed tools from truly unknown ones
							const availableNames = this.agentTools.map((t) => t.name).join(", ");
							const errText = this.disallowedToolNames.has(tc.name)
								? `Tool "${tc.name}" is not available in the side conversation. ` +
								  `Only read-only tools are allowed here: ${availableNames}. ` +
								  `Do not attempt to use ${tc.name} again.`
								: `Unknown tool: ${tc.name}. Available tools: ${availableNames}.`;
							const errorResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: tc.id,
								toolName: tc.name,
								content: [{ type: "text", text: errText }],
								isError: true,
								timestamp: Date.now(),
							};
							this.sideMessages.push(errorResult);
							this.log.push({ role: "tool", text: `⚠ ${errText}` });
							continue;
						}

						// Show tool invocation in log
						const toolLabel = this.formatToolCall(tc);
						this.log.push({ role: "tool", text: `⚙ ${toolLabel}` });
						this.scrollToBottom();
						this.invalidate();
						this.tui.requestRender();

						try {
							const result = await tool.execute(
								tc.id,
								tc.arguments,
								this.abortController?.signal,
							);

							const toolResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: tc.id,
								toolName: tc.name,
								content: result.content,
								details: result.details,
								isError: false,
								timestamp: Date.now(),
							};
							this.sideMessages.push(toolResult);

							// Show brief result summary
							const resultText = result.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n");
							const preview = resultText.length > 200
								? resultText.slice(0, 200) + "…"
								: resultText;
							if (preview) {
								this.log.push({ role: "tool", text: `  ✓ ${preview}` });
							}
						} catch (err: unknown) {
							const errMsg = err instanceof Error ? err.message : String(err);
							const toolResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: tc.id,
								toolName: tc.name,
								content: [{ type: "text", text: errMsg }],
								isError: true,
								timestamp: Date.now(),
							};
							this.sideMessages.push(toolResult);
							this.log.push({ role: "tool", text: `  ✗ ${errMsg}` });
						}

						this.scrollToBottom();
						this.invalidate();
						this.tui.requestRender();
					}

					// Continue the loop — the LLM will see the tool results
					continue;
				}

				// stopReason is "stop", "length", or "error" — we're done
				if (!replyText) {
					this.log.push({ role: "assistant", text: "(empty response)" });
					this.scrollToBottom();
					this.invalidate();
					this.tui.requestRender();
				}

				break;
			}

			this.stopThinking();
			this.invalidate();
			this.tui.requestRender();
		} catch (err: unknown) {
			this.stopThinking();
			this.errorText = `Error: ${err instanceof Error ? err.message : String(err)}`;
			this.scrollToBottom();
			this.invalidate();
			this.tui.requestRender();
		}
	}

	/** Format a tool call for display in the log. */
	private formatToolCall(tc: ToolCall): string {
		switch (tc.name) {
			case "read":
				return `read ${tc.arguments.path ?? ""}${tc.arguments.offset ? ` (offset: ${tc.arguments.offset})` : ""}`;
			case "grep":
				return `grep ${JSON.stringify(tc.arguments.pattern ?? "")}${tc.arguments.path ? ` in ${tc.arguments.path}` : ""}`;
			case "find":
				return `find ${JSON.stringify(tc.arguments.pattern ?? "")}${tc.arguments.path ? ` in ${tc.arguments.path}` : ""}`;
			case "ls":
				return `ls ${tc.arguments.path ?? "."}`;
			default:
				return `${tc.name} ${JSON.stringify(tc.arguments)}`;
		}
	}

	// ── Spinner ──────────────────────────────────────────────────────────────

	private startThinking(): void {
		this.thinking = true;
		this.thinkingDots = 0;
		this.invalidate();
		this.thinkingTimer = setInterval(() => {
			this.thinkingDots = (this.thinkingDots + 1) % 4;
			this.invalidate();
			this.tui.requestRender();
		}, 300);
	}

	private stopThinking(): void {
		this.thinking = false;
		if (this.thinkingTimer !== null) {
			clearInterval(this.thinkingTimer);
			this.thinkingTimer = null;
		}
	}

	// ── Scroll helpers ────────────────────────────────────────────────────────

	/** Build the full unwrapped log lines so we can measure/scroll them. */
	private buildAllLogLines(innerWidth: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		for (const msg of this.log) {
			if (msg.role === "user") {
				const sep = th.fg("dim", "─".repeat(Math.max(0, innerWidth - 5)));
				lines.push(th.fg("accent", th.bold("You ")) + sep);
			} else if (msg.role === "tool") {
				// Tool messages are shown inline without a header separator
				const wrapped = wrapTextWithAnsi(msg.text, innerWidth - 2);
				for (const line of wrapped) {
					lines.push(" " + th.fg("dim", line));
				}
				continue;
			} else {
				const sep = th.fg("dim", "─".repeat(Math.max(0, innerWidth - 5)));
				lines.push(th.fg("success", th.bold("btw ")) + sep);
			}
			const wrapped = wrapTextWithAnsi(msg.text, innerWidth - 2);
			for (const line of wrapped) {
				lines.push(" " + line);
			}
			lines.push("");
		}

		// Spinner / error at the bottom
		if (this.thinking) {
			const dots = "•".repeat(this.thinkingDots + 1);
			const spaces = " ".repeat(3 - this.thinkingDots);
			lines.push(th.fg("warning", `  thinking ${dots}${spaces}`));
		} else if (this.errorText) {
			for (const line of wrapTextWithAnsi(this.errorText, innerWidth - 2)) {
				lines.push(th.fg("error", " " + line));
			}
		}

		return lines;
	}

	/** Scroll so the very last line of the log is visible. */
	private scrollToBottom(logLineCount?: number, viewport?: number): void {
		// We call this without parameters when the log changes; actual clamping
		// happens in render() with the real numbers.  Set to a large value so
		// the clamp in render() does the right thing.
		if (logLineCount !== undefined && viewport !== undefined) {
			this.scrollOffset = Math.max(0, logLineCount - viewport);
		} else {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		}
	}

	// ── Component interface ──────────────────────────────────────────────────

	handleInput(data: string): void {
		// Escape always closes (even while thinking — aborts the request)
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		// While thinking, Ctrl+C also aborts
		if (this.thinking && matchesKey(data, Key.ctrl("c"))) {
			this.abortController?.abort();
			this.stopThinking();
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Scroll the log area
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset++;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += 10;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		// Fixed inner width: 70% of terminal, min 60, max terminal width
		const panelWidth = Math.max(66, width);
		if (this.cachedLines && this.cachedWidth === panelWidth) return this.cachedLines;

		const th = this.theme;
		const innerWidth = panelWidth - 2; // subtract the two border chars │ … │

		// Helper: wrap a line in side borders, padding to innerWidth
		const bordered = (content: string): string => {
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
			return th.fg("borderAccent", "│") + content + pad + th.fg("borderAccent", "│");
		};

		// ── Pre-render chrome to measure its exact height ─────────────────
		// Chrome = top border(1) + divider(1) + editor lines + help(1) + bottom(1)
		const editorLines = this.editor.render(innerWidth);
		const chromeHeight = 1 + 1 + editorLines.length + 1 + 1; // top + divider + editor + help + bottom

		// ── Available log viewport ────────────────────────────────────────
		// The overlay limits total rendered lines to maxHeight (85% of terminal).
		const termRows = (this.tui.terminal as any)?.rows ?? 24;
		const maxPanelRows = Math.floor(termRows * 0.90);
		// Reserve 1 extra row for the optional scroll-hint line inside the log area
		const logViewport = Math.max(2, maxPanelRows - chromeHeight - 1);

		// ── Build full log lines (all messages) ───────────────────────────
		const allLogLines = this.buildAllLogLines(innerWidth);
		const totalLogLines = allLogLines.length;

		// ── Clamp scroll offset ───────────────────────────────────────────
		const maxScroll = Math.max(0, totalLogLines - logViewport);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		// ── Slice the visible window ──────────────────────────────────────
		const visibleLog = allLogLines.slice(this.scrollOffset, this.scrollOffset + logViewport);

		// ── Scroll hint line ──────────────────────────────────────────────
		// Show when there is content above/below the visible window
		const canScrollUp = this.scrollOffset > 0;
		const canScrollDown = this.scrollOffset < maxScroll;
		const needsScrollHint = canScrollUp || canScrollDown;

		// ── Assemble final lines ──────────────────────────────────────────
		const lines: string[] = [];

		// Top border with centred title
		const rawTitle = ` btw · ${this.modelShortId} `;
		const titleStyled = th.fg("accent", rawTitle);
		const totalDashes = Math.max(0, innerWidth - visibleWidth(rawTitle));
		const lDashes = Math.floor(totalDashes / 2);
		const rDashes = totalDashes - lDashes;
		lines.push(
			th.fg("borderAccent", "╭") +
				th.fg("dim", "─".repeat(lDashes)) +
				titleStyled +
				th.fg("dim", "─".repeat(rDashes)) +
				th.fg("borderAccent", "╮"),
		);

		// Log area
		for (const l of visibleLog) {
			lines.push(truncateToWidth(bordered(l), panelWidth));
		}

		// Scroll hint (counts as a log-area row, hence the -1 reservation above)
		if (needsScrollHint) {
			const upPart = canScrollUp ? th.fg("dim", "↑ scroll up") : "";
			const downPart = canScrollDown ? th.fg("dim", "↓ scroll down") : "";
			const sep = canScrollUp && canScrollDown ? th.fg("dim", "  ·  ") : "";
			const hintContent = "  " + upPart + sep + downPart;
			lines.push(truncateToWidth(bordered(hintContent), panelWidth));
		} else if (totalLogLines === 0) {
			// Empty state — nothing rendered yet
			lines.push(truncateToWidth(bordered(""), panelWidth));
		}

		// Divider
		lines.push(
			th.fg("borderAccent", "├") +
				th.fg("dim", "─".repeat(innerWidth)) +
				th.fg("borderAccent", "┤"),
		);

		// Input editor (lines already computed above)
		for (const el of editorLines) {
			lines.push(truncateToWidth(th.fg("borderAccent", "│") + el + th.fg("borderAccent", "│"), panelWidth));
		}

		// Help text
		const helpText = this.thinking
			? th.fg("dim", "  Ctrl+C · cancel   Esc · close")
			: th.fg("dim", "  Enter · send   ↑↓ · scroll   Esc · close");
		lines.push(bordered(helpText));

		// Bottom border
		lines.push(
			th.fg("borderAccent", "╰") +
				th.fg("borderAccent", "─".repeat(innerWidth)) +
				th.fg("borderAccent", "╯"),
		);

		// Centre horizontally inside the full terminal width
		const leftPad = " ".repeat(Math.max(0, Math.floor((width - panelWidth) / 2)));
		this.cachedLines = lines.map((l) => leftPad + l);
		this.cachedWidth = panelWidth;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.editor.invalidate();
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	private close(): void {
		this.abortController?.abort();
		this.stopThinking();
		this.done(null);
	}

	dispose(): void {
		this.abortController?.abort();
		this.stopThinking();
	}
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a side-question in an isolated overlay — the main context is never modified",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			const question = args?.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <your question>", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(
					auth.ok ? `No API key for ${ctx.model.provider}` : (auth as any).error,
					"error",
				);
				return;
			}

			// Snapshot the current main conversation (read-only — we never mutate branch)
			const contextMessages = buildContextMessages(ctx.sessionManager.getBranch());

			// Reuse the active system prompt so the side-agent behaves consistently
			const systemPrompt = ctx.getSystemPrompt();

			// Create read-only tools (read, grep, find, ls) scoped to the current working directory
			const readOnlyTools = createReadOnlyTools(ctx.cwd);
			const readOnlyNames = new Set(readOnlyTools.map((t) => t.name));

			// Collect names of tools the model knows about but aren't allowed here
			const allToolNames = pi.getAllTools().map((t) => t.name);
			const disallowedToolNames = new Set(
				allToolNames.filter((name) => !readOnlyNames.has(name)),
			);

			await ctx.ui.custom<null>(
				(tui, theme, keybindings, done) =>
					new BtwPanel(
						tui,
						theme,
						keybindings,
						done,
						contextMessages,
						question,
						ctx.model!.id,
						ctx.model!,
						auth.apiKey!,
						auth.headers,
						systemPrompt,
						readOnlyTools,
						disallowedToolNames,
					),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						minWidth: 66,
						maxHeight: "90%",
						anchor: "center",
					},
				},
			);

			// Nothing is written back to the main session.
		},
	});
}

import { type Component, Container, type TUI } from "@f5xc-salesdemos/pi-tui";
import { getSymbolTheme, theme } from "../theme/theme";

const GUTTER_WIDTH = 2; // 1 char indicator + 1 char space
const SPINNER_INTERVAL_MS = 80;
const GUTTER_PAD = "  "; // 2 spaces for continuation lines

export interface GutterConfig {
	/** Indicator symbol shown when done (e.g. "●", "✻", "※") */
	symbol: string;
	/** Color function for active state (used for static active indicator) */
	activeColorFn: (s: string) => string;
	/** Color function for done state */
	doneColorFn: (s: string) => string;
	/** Whether to show spinner animation when active */
	animated: boolean;
}

type GutterState = "active" | "done";

/**
 * GutterBlock wraps a child component and prepends a 2-character left gutter
 * to every rendered line. The first line shows an indicator (optionally animated),
 * continuation lines show 2 spaces.
 */
export class GutterBlock<T extends Component> implements Component {
	#child: T;
	#config: GutterConfig;
	#state: GutterState;
	#ui: TUI;

	// Spinner state
	#spinnerFrames: string[];
	#currentFrame = 0;
	#intervalId?: ReturnType<typeof setInterval>;

	constructor(ui: TUI, child: T, config: GutterConfig, initialState: GutterState = "active") {
		this.#child = child;
		this.#config = config;
		this.#state = initialState;
		this.#ui = ui;
		this.#spinnerFrames = getSymbolTheme().spinnerFrames;

		if (initialState === "active" && config.animated) {
			this.#startSpinner();
		}
	}

	get child(): T {
		return this.#child;
	}

	get state(): GutterState {
		return this.#state;
	}

	setDone(): void {
		if (this.#state === "done") return;
		this.#state = "done";
		this.#stopSpinner();
		this.#ui.requestRender();
	}

	/** Switch to thinking mode: change symbol to ✻ and start animated spinner */
	setThinkingMode(): void {
		if (this.#state === "done") return;
		this.#config = {
			symbol: "✻",
			activeColorFn: (s: string) => theme.fg("spinnerAccent", s),
			doneColorFn: (s: string) => theme.fg("dim", s),
			animated: true,
		};
		if (!this.#intervalId) {
			this.#startSpinner();
		}
	}

	/** Forward setExpanded to child if it supports it (duck-typed for isExpandable checks) */
	setExpanded(expanded: boolean): void {
		const child = this.#child as any;
		if (typeof child.setExpanded === "function") {
			child.setExpanded(expanded);
		}
	}

	invalidate(): void {
		this.#child.invalidate?.();
	}

	render(width: number): string[] {
		const childLines = this.#child.render(Math.max(1, width - GUTTER_WIDTH));

		if (childLines.length === 0) {
			return [];
		}

		// Find the first non-empty line — most wrapped components start with a Spacer(1)
		// that produces blank lines. Place the indicator on the first content line, not the spacer.
		let firstContentIdx = 0;
		for (let i = 0; i < childLines.length; i++) {
			if (childLines[i].trim() !== "") {
				firstContentIdx = i;
				break;
			}
		}

		const prefix = this.#buildGutterPrefix();
		const result: string[] = [];
		for (let i = 0; i < childLines.length; i++) {
			result.push((i === firstContentIdx ? prefix : GUTTER_PAD) + childLines[i]);
		}
		return result;
	}

	dispose(): void {
		this.#stopSpinner();
	}

	#buildGutterPrefix(): string {
		if (this.#state === "done") {
			return `${this.#config.doneColorFn(this.#config.symbol)} `;
		}

		if (this.#config.animated) {
			const frame = this.#spinnerFrames[this.#currentFrame];
			return `${this.#config.activeColorFn(frame)} `;
		}

		return `${this.#config.activeColorFn(this.#config.symbol)} `;
	}

	#startSpinner(): void {
		this.#intervalId = setInterval(() => {
			this.#currentFrame = (this.#currentFrame + 1) % this.#spinnerFrames.length;
			this.#ui.requestRender();
		}, SPINNER_INTERVAL_MS);
	}

	#stopSpinner(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}
}

// ============================================================================
// DisposableContainer — stops gutter timers on clear/remove
// ============================================================================

function disposeIfGutter(child: Component): void {
	if (child instanceof GutterBlock) {
		child.dispose();
	}
}

/**
 * Container subclass that disposes GutterBlock children when they are
 * removed or the container is cleared. Prevents orphaned spinner timers.
 */
export class DisposableContainer extends Container {
	override removeChild(component: Component): void {
		disposeIfGutter(component);
		super.removeChild(component);
	}

	override clear(): void {
		for (const child of this.children) {
			disposeIfGutter(child);
		}
		super.clear();
	}
}

// ============================================================================
// Factory functions
// ============================================================================

/** Animated ● gutter for active tool calls — spinner in spinnerAccent, done in dim */
export function createToolGutter<T extends Component>(ui: TUI, child: T): GutterBlock<T> {
	return new GutterBlock(ui, child, {
		symbol: "●",
		activeColorFn: (s: string) => theme.fg("spinnerAccent", s),
		doneColorFn: (s: string) => theme.fg("dim", s),
		animated: true,
	});
}

/** Static ● gutter for assistant text — immediately in done state, white/text color */
export function createTextGutter<T extends Component>(ui: TUI, child: T): GutterBlock<T> {
	return new GutterBlock(
		ui,
		child,
		{
			symbol: "●",
			activeColorFn: (s: string) => theme.fg("text", s),
			doneColorFn: (s: string) => theme.fg("text", s),
			animated: false,
		},
		"done",
	);
}

/**
 * ● gutter for streaming assistant messages — starts active (non-animated, white ●)
 * so it can switch to thinking mode (✻ spinner) if thinking content arrives.
 * Call setDone() when message_end fires.
 */
export function createStreamingAssistantGutter<T extends Component>(ui: TUI, child: T): GutterBlock<T> {
	return new GutterBlock(
		ui,
		child,
		{
			symbol: "●",
			activeColorFn: (s: string) => theme.fg("text", s),
			doneColorFn: (s: string) => theme.fg("text", s),
			animated: false,
		},
		"active",
	);
}

/** Animated ✻ gutter for thinking — spinner in spinnerAccent, done in dim */
export function createThinkingGutter<T extends Component>(ui: TUI, child: T): GutterBlock<T> {
	return new GutterBlock(ui, child, {
		symbol: "✻",
		activeColorFn: (s: string) => theme.fg("spinnerAccent", s),
		doneColorFn: (s: string) => theme.fg("dim", s),
		animated: true,
	});
}

/** Static ※ gutter for system/recap messages — immediately in done state, dim */
export function createSystemGutter<T extends Component>(ui: TUI, child: T): GutterBlock<T> {
	return new GutterBlock(
		ui,
		child,
		{
			symbol: "※",
			activeColorFn: (s: string) => theme.fg("dim", s),
			doneColorFn: (s: string) => theme.fg("dim", s),
			animated: false,
		},
		"done",
	);
}

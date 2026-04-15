import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component, TUI } from "@f5xc-salesdemos/pi-tui";
import {
	createStreamingAssistantGutter,
	createSystemGutter,
	createTextGutter,
	createThinkingGutter,
	createToolGutter,
	DisposableContainer,
	GutterBlock,
} from "../src/modes/components/gutter-block";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTUI(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

/** Minimal Component that renders fixed lines */
function stubComponent(lines: string[]): Component {
	return {
		render: (_width: number) => [...lines],
		invalidate: vi.fn(),
	};
}

/** Component that renders nothing (tool-only assistant turns) */
function emptyComponent(): Component {
	return stubComponent([]);
}

/** Component with a leading blank line (simulates Spacer(1) prefix) */
function spacerPrefixedComponent(content: string): Component {
	return stubComponent(["", content]);
}

/** Component that supports setExpanded (duck-typed Expandable) */
function expandableComponent(lines: string[]): Component & { setExpanded: ReturnType<typeof vi.fn> } {
	return {
		render: (_width: number) => [...lines],
		invalidate: vi.fn(),
		setExpanded: vi.fn(),
	};
}

// Strip ANSI escape codes for assertion clarity
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// GutterBlock — core behavior
// ---------------------------------------------------------------------------

describe("GutterBlock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("render", () => {
		it("prepends 2-char gutter to every child line", () => {
			const ui = mockTUI();
			const child = stubComponent(["hello", "world"]);
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			const lines = gutter.render(80);
			expect(lines).toHaveLength(2);
			// First line has indicator + space, continuation has 2 spaces
			expect(lines[0]).toStartWith("● ");
			expect(lines[0]).toEndWith("hello");
			expect(lines[1]).toStartWith("  ");
			expect(lines[1]).toEndWith("world");
		});

		it("passes width - 2 to child render", () => {
			const ui = mockTUI();
			let receivedWidth = 0;
			const child: Component = {
				render: (width: number) => {
					receivedWidth = width;
					return ["test"];
				},
				invalidate: vi.fn(),
			};
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.render(100);
			expect(receivedWidth).toBe(98);
		});

		it("returns empty array when child renders nothing", () => {
			const ui = mockTUI();
			const child = emptyComponent();
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			expect(gutter.render(80)).toEqual([]);
		});

		it("places indicator on first non-empty line, skipping spacer lines", () => {
			const ui = mockTUI();
			const child = spacerPrefixedComponent("content");
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			const lines = gutter.render(80);
			expect(lines).toHaveLength(2);
			// First line (blank spacer) gets pad, not indicator
			expect(lines[0]).toBe("  ");
			// Second line (content) gets indicator
			expect(lines[1]).toStartWith("● ");
			expect(lines[1]).toEndWith("content");
		});

		it("clamps child width to minimum 1", () => {
			const ui = mockTUI();
			let receivedWidth = 0;
			const child: Component = {
				render: (width: number) => {
					receivedWidth = width;
					return ["x"];
				},
				invalidate: vi.fn(),
			};
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.render(1);
			expect(receivedWidth).toBe(1);
		});
	});

	describe("state transitions", () => {
		it("starts in active state by default", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => `[active:${s}]`,
				doneColorFn: s => `[done:${s}]`,
				animated: false,
			});

			expect(gutter.state).toBe("active");
			const lines = gutter.render(80);
			expect(lines[0]).toContain("[active:●]");
		});

		it("can start in done state", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(
				ui,
				stubComponent(["x"]),
				{
					symbol: "●",
					activeColorFn: s => `[active:${s}]`,
					doneColorFn: s => `[done:${s}]`,
					animated: false,
				},
				"done",
			);

			expect(gutter.state).toBe("done");
			const lines = gutter.render(80);
			expect(lines[0]).toContain("[done:●]");
		});

		it("transitions from active to done via setDone()", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => `[active:${s}]`,
				doneColorFn: s => `[done:${s}]`,
				animated: false,
			});

			gutter.setDone();

			expect(gutter.state).toBe("done");
			const lines = gutter.render(80);
			expect(lines[0]).toContain("[done:●]");
		});

		it("setDone() requests a render", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.setDone();
			expect(ui.requestRender).toHaveBeenCalled();
		});

		it("setDone() is idempotent", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.setDone();
			gutter.setDone(); // second call should not throw or re-request
			expect(gutter.state).toBe("done");
		});

		it("setDone() is a no-op if already done", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(
				ui,
				stubComponent(["x"]),
				{
					symbol: "●",
					activeColorFn: s => s,
					doneColorFn: s => s,
					animated: false,
				},
				"done",
			);

			gutter.setDone();
			// requestRender should NOT be called since state didn't change
			expect(ui.requestRender).not.toHaveBeenCalled();
		});
	});

	describe("thinking mode", () => {
		it("switches symbol to ✻ when setThinkingMode() is called", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.setThinkingMode();

			// After setDone, the done symbol should be ✻
			gutter.setDone();
			const lines = gutter.render(80);
			expect(stripAnsi(lines[0])).toContain("✻");
		});

		it("setThinkingMode() is ignored when already done", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(
				ui,
				stubComponent(["x"]),
				{
					symbol: "●",
					activeColorFn: s => s,
					doneColorFn: s => `[done:${s}]`,
					animated: false,
				},
				"done",
			);

			gutter.setThinkingMode();
			const lines = gutter.render(80);
			// Should still show ●, not ✻
			expect(lines[0]).toContain("[done:●]");
		});

		it("setThinkingMode() enables animation", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.setThinkingMode();
			// The spinner should be running — wait and check requestRender is called
			// (spinner ticks every 80ms)
			return new Promise<void>(resolve => {
				setTimeout(() => {
					expect(ui.requestRender).toHaveBeenCalled();
					gutter.dispose(); // clean up timer
					resolve();
				}, 100);
			});
		});
	});

	describe("spinner animation", () => {
		it("starts spinner when animated and active", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: true,
			});

			// Spinner should call requestRender after 80ms
			return new Promise<void>(resolve => {
				setTimeout(() => {
					expect(ui.requestRender).toHaveBeenCalled();
					gutter.dispose();
					resolve();
				}, 100);
			});
		});

		it("does not start spinner when animated but initial state is done", () => {
			const ui = mockTUI();
			const _gutter = new GutterBlock(
				ui,
				stubComponent(["x"]),
				{
					symbol: "●",
					activeColorFn: s => s,
					doneColorFn: s => s,
					animated: true,
				},
				"done",
			);

			return new Promise<void>(resolve => {
				setTimeout(() => {
					// requestRender should NOT have been called by spinner
					expect(ui.requestRender).not.toHaveBeenCalled();
					resolve();
				}, 100);
			});
		});

		it("stops spinner on setDone()", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: true,
			});

			gutter.setDone();
			(ui.requestRender as ReturnType<typeof vi.fn>).mockClear();

			return new Promise<void>(resolve => {
				setTimeout(() => {
					// After setDone, spinner should have stopped — no more requestRender calls
					expect(ui.requestRender).not.toHaveBeenCalled();
					resolve();
				}, 100);
			});
		});

		it("stops spinner on dispose()", () => {
			const ui = mockTUI();
			const gutter = new GutterBlock(ui, stubComponent(["x"]), {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: true,
			});

			gutter.dispose();
			(ui.requestRender as ReturnType<typeof vi.fn>).mockClear();

			return new Promise<void>(resolve => {
				setTimeout(() => {
					expect(ui.requestRender).not.toHaveBeenCalled();
					resolve();
				}, 100);
			});
		});
	});

	describe("child access", () => {
		it("exposes child via getter", () => {
			const ui = mockTUI();
			const child = stubComponent(["x"]);
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			expect(gutter.child).toBe(child);
		});

		it("forwards invalidate to child", () => {
			const ui = mockTUI();
			const child = stubComponent(["x"]);
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.invalidate();
			expect(child.invalidate).toHaveBeenCalled();
		});
	});

	describe("setExpanded forwarding", () => {
		it("forwards setExpanded to child when child supports it", () => {
			const ui = mockTUI();
			const child = expandableComponent(["x"]);
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			gutter.setExpanded(true);
			expect(child.setExpanded).toHaveBeenCalledWith(true);

			gutter.setExpanded(false);
			expect(child.setExpanded).toHaveBeenCalledWith(false);
		});

		it("does not throw when child lacks setExpanded", () => {
			const ui = mockTUI();
			const child = stubComponent(["x"]);
			const gutter = new GutterBlock(ui, child, {
				symbol: "●",
				activeColorFn: s => s,
				doneColorFn: s => s,
				animated: false,
			});

			// Should not throw
			expect(() => gutter.setExpanded(true)).not.toThrow();
		});
	});
});

// ---------------------------------------------------------------------------
// DisposableContainer
// ---------------------------------------------------------------------------

describe("DisposableContainer", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disposes GutterBlock children on clear()", () => {
		const ui = mockTUI();
		const container = new DisposableContainer();
		const gutter = new GutterBlock(ui, stubComponent(["x"]), {
			symbol: "●",
			activeColorFn: s => s,
			doneColorFn: s => s,
			animated: true,
		});
		container.addChild(gutter);

		container.clear();

		// Spinner should be stopped — verify no further requestRender calls
		(ui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		return new Promise<void>(resolve => {
			setTimeout(() => {
				expect(ui.requestRender).not.toHaveBeenCalled();
				resolve();
			}, 100);
		});
	});

	it("disposes GutterBlock on removeChild()", () => {
		const ui = mockTUI();
		const container = new DisposableContainer();
		const gutter = new GutterBlock(ui, stubComponent(["x"]), {
			symbol: "●",
			activeColorFn: s => s,
			doneColorFn: s => s,
			animated: true,
		});
		container.addChild(gutter);

		container.removeChild(gutter);

		(ui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		return new Promise<void>(resolve => {
			setTimeout(() => {
				expect(ui.requestRender).not.toHaveBeenCalled();
				resolve();
			}, 100);
		});
	});

	it("does not break when clearing non-GutterBlock children", () => {
		const container = new DisposableContainer();
		const child = stubComponent(["x"]);
		container.addChild(child);

		// Should not throw
		expect(() => container.clear()).not.toThrow();
		expect(container.children).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

describe("factory functions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("createToolGutter starts active with animated spinner", () => {
		const ui = mockTUI();
		const gutter = createToolGutter(ui, stubComponent(["x"]));

		expect(gutter.state).toBe("active");
		gutter.dispose(); // clean up timer
	});

	it("createTextGutter starts in done state", () => {
		const ui = mockTUI();
		const gutter = createTextGutter(ui, stubComponent(["x"]));

		expect(gutter.state).toBe("done");
	});

	it("createStreamingAssistantGutter starts active without animation", () => {
		const ui = mockTUI();
		const gutter = createStreamingAssistantGutter(ui, stubComponent(["x"]));

		expect(gutter.state).toBe("active");
		// No spinner timer should be running since animated=false
		(ui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		return new Promise<void>(resolve => {
			setTimeout(() => {
				expect(ui.requestRender).not.toHaveBeenCalled();
				resolve();
			}, 100);
		});
	});

	it("createThinkingGutter starts active with animated spinner", () => {
		const ui = mockTUI();
		const gutter = createThinkingGutter(ui, stubComponent(["x"]));

		expect(gutter.state).toBe("active");
		gutter.dispose();
	});

	it("createSystemGutter starts in done state", () => {
		const ui = mockTUI();
		const gutter = createSystemGutter(ui, stubComponent(["x"]));

		expect(gutter.state).toBe("done");
	});

	it("createToolGutter uses ● symbol", () => {
		const ui = mockTUI();
		const gutter = createToolGutter(ui, stubComponent(["x"]));
		gutter.setDone();

		const lines = gutter.render(80);
		expect(stripAnsi(lines[0])).toContain("●");
	});

	it("createSystemGutter uses ※ symbol", () => {
		const ui = mockTUI();
		const gutter = createSystemGutter(ui, stubComponent(["x"]));

		const lines = gutter.render(80);
		expect(stripAnsi(lines[0])).toContain("※");
	});

	it("createThinkingGutter uses ✻ symbol", () => {
		const ui = mockTUI();
		const gutter = createThinkingGutter(ui, stubComponent(["x"]));
		gutter.setDone();

		const lines = gutter.render(80);
		expect(stripAnsi(lines[0])).toContain("✻");
	});
});

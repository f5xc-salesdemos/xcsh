import { beforeAll, describe, expect, it } from "bun:test";
import { WelcomeComponent } from "@f5xc-salesdemos/xcsh/modes/components/welcome";
import type { ModelStatus, WelcomeProfileStatus } from "@f5xc-salesdemos/xcsh/modes/components/welcome-checks";
import { initTheme } from "@f5xc-salesdemos/xcsh/modes/theme/theme";

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
function renderPlain(component: WelcomeComponent, width = 120): string[] {
	return component.render(width).map(stripAnsi);
}

describe("WelcomeComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	it("renders connected model", () => {
		const c = new WelcomeComponent("15.15.0", { state: "connected", provider: "litellm", latencyMs: 142 });
		const out = renderPlain(c).join("\n");
		expect(out).toContain("Model Provider");
		expect(out).toContain("litellm");
		expect(out).toContain("connected (142ms)");
	});

	it("renders no_provider", () => {
		const c = new WelcomeComponent("15.15.0", { state: "no_provider", provider: "litellm" });
		const out = renderPlain(c).join("\n");
		expect(out).toContain("No model provider configured");
		expect(out).toContain("/login");
	});

	it("renders auth_error", () => {
		const c = new WelcomeComponent("15.15.0", { state: "auth_error", provider: "litellm" });
		const out = renderPlain(c).join("\n");
		expect(out).toContain("connection failed");
		expect(out).toContain("/login");
	});

	it("hides profile when undefined", () => {
		const c = new WelcomeComponent("15.15.0", { state: "connected", provider: "litellm", latencyMs: 100 });
		expect(renderPlain(c).join("\n")).not.toContain("F5 XC Profile");
	});

	it("shows profile when provided", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const ps: WelcomeProfileStatus = { state: "connected", name: "production", latencyMs: 42 };
		const c = new WelcomeComponent("15.15.0", ms, ps);
		const out = renderPlain(c).join("\n");
		expect(out).toContain("F5 XC Profile");
		expect(out).toContain("production");
	});

	it("shows profile auth_error with update hint", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const c = new WelcomeComponent("15.15.0", ms, { state: "auth_error", name: "prod" });
		const out = renderPlain(c).join("\n");
		expect(out).toContain("token invalid");
		expect(out).toContain("Run /profile to update");
	});

	it("shows profile offline with network hint", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const c = new WelcomeComponent("15.15.0", ms, { state: "offline", name: "prod" });
		const out = renderPlain(c).join("\n");
		expect(out).toContain("unreachable");
		expect(out).toContain("Check network, /profile");
	});

	it("shows no_profile hint", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const c = new WelcomeComponent("15.15.0", ms, { state: "no_profile" });
		expect(renderPlain(c).join("\n")).toContain("No profile configured");
	});

	it("renders version header", () => {
		const c = new WelcomeComponent("15.15.0", { state: "connected", provider: "litellm", latencyMs: 100 });
		expect(renderPlain(c).join("\n")).toContain("xcsh v15.15.0");
	});

	it("returns empty for narrow terminal", () => {
		const c = new WelcomeComponent("15.15.0", { state: "connected", provider: "litellm", latencyMs: 100 });
		expect(c.render(3)).toEqual([]);
	});

	describe("content-driven width", () => {
		const connected: ModelStatus = { state: "connected", provider: "anthropic", latencyMs: 100 };

		function boxWidth(component: WelcomeComponent, termWidth = 120): number {
			const lines = renderPlain(component, termWidth);
			return lines.length > 0 ? lines[0].length : 0;
		}

		it("box is no wider than the content requires", () => {
			const c = new WelcomeComponent("15.15.0", connected);
			const width = boxWidth(c);
			// Widest right-column line is ~33 chars ("✓ anthropic — connected (100ms)")
			// Left column is 48-50, plus 3 borders = box should be well under 100
			expect(width).toBeLessThan(100);
		});

		it("no_profile state widens box to fit hint text", () => {
			const withoutProfile = new WelcomeComponent("15.15.0", connected);
			const withNoProfile = new WelcomeComponent("15.15.0", connected, { state: "no_profile" });
			// "Run /profile create <name> <url> <token>" is wider than "✓ anthropic — connected"
			expect(boxWidth(withNoProfile)).toBeGreaterThan(boxWidth(withoutProfile));
		});

		it("profile auth_error hint is not truncated at 80 columns", () => {
			const c = new WelcomeComponent("15.15.0", connected, { state: "auth_error", name: "prod" });
			const lines = renderPlain(c, 80);
			const hintLine = lines.find(l => l.includes("/profile to update"));
			expect(hintLine).toBeDefined();
			expect(hintLine).not.toContain("\u2026");
		});

		it("profile offline hint is not truncated at 80 columns", () => {
			const c = new WelcomeComponent("15.15.0", connected, { state: "offline", name: "prod" });
			const lines = renderPlain(c, 80);
			const hintLine = lines.find(l => l.includes("Check network"));
			expect(hintLine).toBeDefined();
			expect(hintLine).not.toContain("\u2026");
		});

		it("no_profile hint is not truncated at 100 columns", () => {
			const c = new WelcomeComponent("15.15.0", connected, { state: "no_profile" });
			const out = renderPlain(c, 100).join("\n");
			expect(out).toContain("Run /profile create <name> <url> <token>");
			expect(out).not.toContain("\u2026");
		});

		it("long profile name caps at terminal width", () => {
			const longName = "a]b-c_d".repeat(9); // 63 chars
			const c = new WelcomeComponent("15.15.0", connected, { state: "connected", name: longName, latencyMs: 50 });
			const width = boxWidth(c, 100);
			// Box must not exceed terminal width - 2 (margin)
			expect(width).toBeLessThanOrEqual(98);
			// But should still render (not empty)
			expect(width).toBeGreaterThan(0);
		});
	});
});

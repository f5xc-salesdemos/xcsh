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

	it("shows profile auth_error", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const c = new WelcomeComponent("15.15.0", ms, { state: "auth_error", name: "prod" });
		expect(renderPlain(c).join("\n")).toContain("token invalid");
	});

	it("shows profile offline", () => {
		const ms: ModelStatus = { state: "connected", provider: "litellm", latencyMs: 100 };
		const c = new WelcomeComponent("15.15.0", ms, { state: "offline", name: "prod" });
		expect(renderPlain(c).join("\n")).toContain("unreachable");
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
});

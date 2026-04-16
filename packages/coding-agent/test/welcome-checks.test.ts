import { describe, expect, it } from "bun:test";
import type { Model } from "@f5xc-salesdemos/pi-ai";
import { runWelcomeChecks } from "@f5xc-salesdemos/xcsh/modes/components/welcome-checks";

function mockAuth(opts: { hasAuth?: boolean; peekApiKey?: string | undefined }) {
	return { hasAuth: () => opts.hasAuth ?? false, peekApiKey: async () => opts.peekApiKey } as any;
}
function mockModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "t",
		name: "T",
		api: "openai-completions" as any,
		provider: "litellm",
		baseUrl: "http://localhost:4000/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model;
}

describe("runWelcomeChecks", () => {
	it("returns no_provider when hasAuth is false", async () => {
		const r = await runWelcomeChecks(mockModel(), mockAuth({ hasAuth: false }));
		expect(r.model.state).toBe("no_provider");
		expect(r.profile).toBeUndefined();
	});
	it("returns no_provider for undefined model", async () => {
		const r = await runWelcomeChecks(undefined, mockAuth({ hasAuth: false }));
		expect(r.model.provider).toBe("unknown");
	});
	it("returns auth_error when peekApiKey undefined", async () => {
		const r = await runWelcomeChecks(mockModel(), mockAuth({ hasAuth: true, peekApiKey: undefined }));
		expect(r.model.state).toBe("auth_error");
		expect(r.profile).toBeUndefined();
	});
	it("returns auth_error for empty baseUrl", async () => {
		const r = await runWelcomeChecks(mockModel({ baseUrl: "" }), mockAuth({ hasAuth: true, peekApiKey: "k" }));
		expect(r.model.state).toBe("auth_error");
	});
	it("never includes profile when model fails", async () => {
		const r = await runWelcomeChecks(mockModel(), mockAuth({ hasAuth: false }));
		expect(r.profile).toBeUndefined();
	});
});

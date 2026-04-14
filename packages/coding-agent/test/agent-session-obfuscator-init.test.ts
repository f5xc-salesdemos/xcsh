/**
 * Regression test: #resolveObfuscator must be initialized before
 * buildDisplaySessionContext() is called in the AgentSession constructor.
 *
 * Bug: commit e97439c79 changed #obfuscator (a value) to #resolveObfuscator
 * (a function), but assigned it at line 588 — after buildDisplaySessionContext()
 * is called at line 572. Calling undefined() throws TypeError.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@f5xc-salesdemos/pi-agent-core";
import { getBundledModel } from "@f5xc-salesdemos/pi-ai";
import { TempDir } from "@f5xc-salesdemos/pi-utils";
import { ModelRegistry } from "@f5xc-salesdemos/xcsh/config/model-registry";
import { Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { AgentSession } from "@f5xc-salesdemos/xcsh/session/agent-session";
import { AuthStorage } from "@f5xc-salesdemos/xcsh/session/auth-storage";
import { SessionManager } from "@f5xc-salesdemos/xcsh/session/session-manager";
import { SecretObfuscator } from "../src/secrets/obfuscator";

describe("AgentSession obfuscator initialization order", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-obfuscator-init-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	it("constructs without throwing when no obfuscator is provided", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
		});

		// This should not throw — #resolveObfuscator must be initialized
		// before buildDisplaySessionContext() is called in the constructor.
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		// Verify buildDisplaySessionContext() works after construction too
		const ctx = session.buildDisplaySessionContext();
		expect(ctx).toBeDefined();
	});

	it("constructs without throwing when an obfuscator is provided", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
		});

		const obfuscator = new SecretObfuscator([{ type: "plain", content: "super-secret-token-12345" }]);

		// Construction must not throw even with an active obfuscator
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			obfuscator,
		});

		const ctx = session.buildDisplaySessionContext();
		expect(ctx).toBeDefined();
	});
});

import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@f5xc-salesdemos/pi-agent-core";
import { getBundledModel } from "@f5xc-salesdemos/pi-ai";
import { AssistantMessageEventStream } from "@f5xc-salesdemos/pi-ai/utils/event-stream";
import { TempDir } from "@f5xc-salesdemos/pi-utils";
import { ModelRegistry } from "@f5xc-salesdemos/xcsh/config/model-registry";
import { Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { AgentSession } from "@f5xc-salesdemos/xcsh/session/agent-session";
import { AuthStorage } from "@f5xc-salesdemos/xcsh/session/auth-storage";
import { convertToLlm } from "@f5xc-salesdemos/xcsh/session/messages";
import { SessionManager } from "@f5xc-salesdemos/xcsh/session/session-manager";
import { Type } from "@sinclair/typebox";

class MockAssistantStream extends AssistantMessageEventStream {}

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-agent-session-force-tool-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());

	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [bashTool, writeTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new MockAssistantStream(),
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

it("forces specific tool, then transitions to none, then clears", () => {
	session.setForcedToolChoice("write");

	const first = session.nextToolChoice();
	const second = session.nextToolChoice();
	const third = session.nextToolChoice();

	expect(first).toEqual({ type: "tool", name: "write" });
	// After the forced call, "none" prevents the loop from making more tool calls
	expect(second).toBe("none");
	// After "none" is consumed, override clears entirely
	expect(third).toBeUndefined();
});

it("throws when forcing a non-active tool", () => {
	expect(() => session.setForcedToolChoice("read")).toThrow('Tool "read" is not currently active.');
});

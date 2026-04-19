import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@f5xc-salesdemos/pi-agent-core";
import { TempDir } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { initTheme } from "@f5xc-salesdemos/xcsh/modes/theme/theme";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

describe("InteractiveMode welcome banner status checks", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		_resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-welcome-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: "Test", tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, () => {}, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		_resetSettingsForTest();
	});

	it("renders the welcome banner with Model Provider section after init", async () => {
		await mode.init();
		const output = Bun.stripANSI(mode.ui.render(120).join("\n"));
		expect(output).toContain("Model Provider");
	});

	it("does not render old Tips/LSP/Sessions sections", async () => {
		await mode.init();
		const output = Bun.stripANSI(mode.ui.render(120).join("\n"));
		expect(output).not.toContain("Tips");
		expect(output).not.toContain("LSP Servers");
		expect(output).not.toContain("Recent sessions");
	});
});

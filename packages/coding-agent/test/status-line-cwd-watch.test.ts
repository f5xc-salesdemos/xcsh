import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import { EventBus } from "../src/utils/event-bus";

beforeAll(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: os.tmpdir() });
	await initTheme();
});

function makeSession(): AgentSession {
	return {
		state: { messages: [], model: undefined },
		isFastModeEnabled: () => false,
		isStreaming: false,
		sessionManager: undefined,
		modelRegistry: { isUsingOAuth: () => false },
		settings: undefined,
		getAsyncJobSnapshot: () => ({ running: [], queued: [] }),
		extensionRunner: undefined,
	} as unknown as AgentSession;
}

describe("StatusLineComponent.watchCwd", () => {
	it("fires onStatusChanged when the eventBus emits cwd:changed", () => {
		const component = new StatusLineComponent(makeSession());
		const bus = new EventBus();

		let changed = 0;
		component.onStatusChanged(() => {
			changed += 1;
		});

		component.watchCwd(bus);
		bus.emit("cwd:changed", "/tmp/new-location");

		expect(changed).toBeGreaterThan(0);
	});

	it("stops firing after dispose", () => {
		const component = new StatusLineComponent(makeSession());
		const bus = new EventBus();

		let changed = 0;
		component.onStatusChanged(() => {
			changed += 1;
		});
		component.watchCwd(bus);
		component.dispose();

		bus.emit("cwd:changed", "/tmp/after-dispose");

		expect(changed).toBe(0);
	});
});

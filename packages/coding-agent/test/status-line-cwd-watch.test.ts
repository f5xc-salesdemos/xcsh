import { beforeAll, describe, expect, it } from "bun:test";
import { StatusLineComponent } from "@f5xc-salesdemos/xcsh/modes/components/status-line";
import { initTheme } from "@f5xc-salesdemos/xcsh/modes/theme/theme";
import type { AgentSession } from "@f5xc-salesdemos/xcsh/session/agent-session";
import { EventBus } from "@f5xc-salesdemos/xcsh/utils/event-bus";

beforeAll(async () => {
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

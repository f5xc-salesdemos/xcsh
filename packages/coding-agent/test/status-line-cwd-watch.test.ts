import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellPwd, setShellPwd } from "@f5xc-salesdemos/pi-utils";
import { $ } from "bun";
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

	it("renders the new shellPwd in the top border after cwd:changed", async () => {
		// Regression for #118: when the assistant cd's into a different directory,
		// the next getTopBorder() call must reflect the new path, since the
		// path segment now reads ctx.cwd (which #buildSegmentContext populates
		// from getShellPwd()).
		const originalShellPwd = getShellPwd();
		const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-repo-a-"));
		const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-repo-b-"));

		try {
			await $`git init -q -b main`.cwd(repoA).quiet();
			await $`git init -q -b main`.cwd(repoB).quiet();

			setShellPwd(repoA);
			const component = new StatusLineComponent(makeSession());
			const bus = new EventBus();
			component.watchCwd(bus);

			setShellPwd(repoB);
			bus.emit("cwd:changed", repoB);

			const rendered = component.getTopBorder(200).content;
			const stripped = rendered.replace(/\u001b\[[0-9;]*m/g, "");

			expect(stripped).toContain(path.basename(repoB));
			expect(stripped).not.toContain(path.basename(repoA));

			component.dispose();
		} finally {
			setShellPwd(originalShellPwd);
			fs.rmSync(repoA, { recursive: true, force: true });
			fs.rmSync(repoB, { recursive: true, force: true });
		}
	});
});

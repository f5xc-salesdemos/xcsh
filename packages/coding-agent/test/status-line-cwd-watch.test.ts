import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellPwd, setShellPwd } from "@f5xc-salesdemos/pi-utils";
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

	it("renders the cwd from the cwd:changed event payload, not getShellPwd()", () => {
		// Regression for #118: the statusline must track the cwd carried by the
		// cwd:changed event (the assistant's working directory), not the global
		// shellPwd. The event payload and shellPwd can diverge when a user !cd
		// command updates shellPwd but the assistant's cwd stays unchanged.
		//
		// Use persistent, pid-scoped directories rather than mkdtempSync with
		// cleanup. getTopBorder() kicks off fire-and-forget async IIFEs inside
		// the component (#getGitStatus, #isDefaultBranch) that spawn `git` with
		// the tracked cwd; if the dir is rm'd before those subprocesses run,
		// posix_spawn fails with ENOENT and the rejection surfaces in whatever
		// test happens to run next. Persistent dirs let those queries spawn
		// cleanly, return "not a repository," and be handled by the existing
		// catch blocks — no cross-test pollution.
		const originalShellPwd = getShellPwd();
		const dirA = path.join(os.tmpdir(), `xcsh-cwd-a-${process.pid}`);
		const dirB = path.join(os.tmpdir(), `xcsh-cwd-b-${process.pid}`);
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });

		try {
			setShellPwd(dirA);
			const component = new StatusLineComponent(makeSession());
			const bus = new EventBus();
			component.watchCwd(bus);

			// Only emit the event -- do NOT call setShellPwd(dirB).
			// This proves the statusline reads the event payload, not the global.
			bus.emit("cwd:changed", dirB);

			const rendered = component.getTopBorder(200).content;
			const stripped = rendered.replace(/\u001b\[[0-9;]*m/g, "");

			expect(stripped).toContain(path.basename(dirB));
			expect(stripped).not.toContain(path.basename(dirA));

			component.dispose();
		} finally {
			setShellPwd(originalShellPwd);
		}
	});

	it("setCwd updates the displayed directory without an event bus", () => {
		const originalShellPwd = getShellPwd();
		const dirA = path.join(os.tmpdir(), `xcsh-cwd-setcwd-a-${process.pid}`);
		const dirB = path.join(os.tmpdir(), `xcsh-cwd-setcwd-b-${process.pid}`);
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });

		try {
			setShellPwd(dirA);
			const component = new StatusLineComponent(makeSession());

			// setCwd should update the displayed path without eventBus.
			component.setCwd(dirB);

			const rendered = component.getTopBorder(200).content;
			const stripped = rendered.replace(/\u001b\[[0-9;]*m/g, "");

			expect(stripped).toContain(path.basename(dirB));
			expect(stripped).not.toContain(path.basename(dirA));

			component.dispose();
		} finally {
			setShellPwd(originalShellPwd);
		}
	});
});

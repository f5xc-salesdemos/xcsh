import { beforeEach, describe, expect, it } from "bun:test";
import { getProjectDir, getShellPwd, setProjectDir, setShellPwd } from "../src/dirs";

describe("getShellPwd / setShellPwd", () => {
	const originalCwd = getProjectDir();

	beforeEach(() => {
		// Reset both to the original CWD before each test
		setProjectDir(originalCwd);
		setShellPwd(originalCwd);
	});

	it("initially matches the Agent CWD (getProjectDir)", () => {
		expect(getShellPwd()).toBe(getProjectDir());
	});

	it("setShellPwd updates getShellPwd", () => {
		setShellPwd("/tmp");
		expect(getShellPwd()).toBe("/tmp");
	});

	it("setShellPwd does NOT change getProjectDir (Agent CWD)", () => {
		const agentCwd = getProjectDir();
		setShellPwd("/tmp");
		expect(getProjectDir()).toBe(agentCwd);
		expect(getShellPwd()).toBe("/tmp");
	});

	it("setProjectDir does NOT change getShellPwd", () => {
		setShellPwd("/tmp");
		setProjectDir(originalCwd);
		expect(getShellPwd()).toBe("/tmp");
	});

	it("resolves relative paths", () => {
		setShellPwd("/tmp/../var");
		expect(getShellPwd()).toBe("/var");
	});
});

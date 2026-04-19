import { describe, expect, it } from "bun:test";
import { normalizeLitellmBase } from "../src/utils/anthropic-auth";

type Case = { input: string; expected: string; description: string };

const cases: Case[] = [
	{ input: "https://proxy.example.com", expected: "https://proxy.example.com", description: "bare host" },
	{ input: "https://proxy.example.com/", expected: "https://proxy.example.com", description: "trailing slash" },
	{
		input: "https://proxy.example.com///",
		expected: "https://proxy.example.com",
		description: "multiple trailing slashes",
	},
	{
		input: "https://proxy.example.com/anthropic",
		expected: "https://proxy.example.com",
		description: "/anthropic suffix",
	},
	{
		input: "https://proxy.example.com/anthropic/",
		expected: "https://proxy.example.com",
		description: "/anthropic/ with trailing slash",
	},
	{ input: "https://proxy.example.com/v1", expected: "https://proxy.example.com", description: "/v1 suffix" },
	{
		input: "https://proxy.example.com/api/v1",
		expected: "https://proxy.example.com",
		description: "/api/v1 suffix (Bug 3)",
	},
	{
		input: "https://proxy.example.com/api/v1/",
		expected: "https://proxy.example.com",
		description: "/api/v1/ with trailing slash",
	},
	{
		input: "https://proxy.example.com/api/v1/anthropic",
		expected: "https://proxy.example.com",
		description: "/api/v1/anthropic suffix",
	},
	{
		input: "https://proxy.example.com/v1/anthropic",
		expected: "https://proxy.example.com",
		description: "/v1/anthropic suffix",
	},
	{
		input: "https://proxy.example.com/v1/anthropic/v1",
		expected: "https://proxy.example.com",
		description: "/v1/anthropic/v1 mixed",
	},
	{
		input: "https://proxy.example.com:8443/api/v1",
		expected: "https://proxy.example.com:8443",
		description: "port preserved",
	},
	{
		input: "https://proxy.example.com/service-v1-legacy",
		expected: "https://proxy.example.com/service-v1-legacy",
		description: "partial-match in path segment NOT stripped",
	},
	{
		input: "https://proxy.example.com//api/v1//anthropic",
		expected: "https://proxy.example.com",
		description: "double-slash misconfig collapses cleanly, does not yield empty host",
	},
	{ input: "", expected: "", description: "empty input returns empty string without throwing" },
];

describe("normalizeLitellmBase matrix", () => {
	for (const { input, expected, description } of cases) {
		it(`${description}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(normalizeLitellmBase(input)).toBe(expected);
		});
	}
});

describe("normalizeLitellmBase safety invariants", () => {
	it("never returns an empty string for a non-empty input that has a host", () => {
		expect(normalizeLitellmBase("https://proxy.example.com").length).toBeGreaterThan(0);
		expect(normalizeLitellmBase("https://proxy.example.com//api/v1//anthropic").length).toBeGreaterThan(0);
	});

	it("is idempotent — applying twice yields the same result", () => {
		for (const { input } of cases) {
			const once = normalizeLitellmBase(input);
			const twice = normalizeLitellmBase(once);
			expect(twice).toBe(once);
		}
	});
});

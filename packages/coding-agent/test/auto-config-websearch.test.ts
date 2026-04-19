import { describe, expect, it } from "bun:test";
import { YAML } from "bun";
import { generateConfigYml } from "../src/config/auto-config";

describe("generateConfigYml — web search provider contract", () => {
	it("emits providers.webSearch: anthropic as a literal substring", () => {
		const yml = generateConfigYml();
		expect(yml).toContain("webSearch: anthropic");
	});

	it("parses back to an object with providers.webSearch === 'anthropic'", () => {
		const yml = generateConfigYml();
		const parsed = YAML.parse(yml) as { providers?: { webSearch?: string } };
		expect(parsed.providers?.webSearch).toBe("anthropic");
	});

	it("places webSearch under the providers section (not top-level, not under web_search)", () => {
		const yml = generateConfigYml();
		const parsed = YAML.parse(yml) as Record<string, unknown>;
		expect(parsed.webSearch).toBeUndefined();
		expect(parsed.web_search).toBeUndefined();
		expect((parsed.providers as { webSearch?: string } | undefined)?.webSearch).toBe("anthropic");
	});

	it("does not emit the dead key pattern `web_search:\\n  provider:`", () => {
		const yml = generateConfigYml();
		expect(yml).not.toMatch(/web_search\s*:\s*\n\s+provider\s*:/);
	});

	it("preserves the existing providers.image: openai guarantee", () => {
		const yml = generateConfigYml();
		const parsed = YAML.parse(yml) as { providers?: { image?: string } };
		expect(parsed.providers?.image).toBe("openai");
	});

	it("keeps webSearch indented under providers (not at root)", () => {
		const yml = generateConfigYml();
		const lines = yml.split("\n");
		const providersIdx = lines.findIndex(l => l.trim() === "providers:");
		const webSearchIdx = lines.findIndex(l => l.trim().startsWith("webSearch:"));
		expect(providersIdx).toBeGreaterThanOrEqual(0);
		expect(webSearchIdx).toBeGreaterThan(providersIdx);
		const wsLine = lines[webSearchIdx];
		const indent = wsLine.length - wsLine.trimStart().length;
		expect(indent).toBeGreaterThan(0);
	});
});

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath } from "./dirs";

/**
 * Shared reader for `~/.xcsh/agent/models.yml`.
 *
 * Parses only the shape written by the LiteLLM auto-config:
 *
 *     providers:
 *       <name>:
 *         baseUrl: "https://..."
 *         apiKey: ENV_VAR | "literal" | !shellSecret
 *
 * Consumers (anthropic-auth, auto-config) interpret the structured result
 * and apply their own fallback / resolution policy.
 */

export type ApiKeyValue =
	| { kind: "envVar"; name: string }
	| { kind: "literal"; value: string; wasQuoted: boolean }
	| { kind: "shellSecret"; raw: string };

export interface ProviderYmlEntry {
	baseUrl?: string;
	apiKey?: ApiKeyValue;
}

/**
 * Read a named provider block from models.yml.
 * Returns null if the file is unreadable or the named block is absent.
 */
export function readProviderFromModelsYml(providerName: string, modelsYmlPath?: string): ProviderYmlEntry | null {
	const resolvedPath = resolveModelsYmlPath(modelsYmlPath);
	if (!resolvedPath) return null;

	let content: string;
	try {
		content = fs.readFileSync(resolvedPath, "utf-8");
	} catch {
		return null;
	}

	const lines = content.split("\n");
	const providerHeaderRe = new RegExp(`^(\\s*)${escapeRegex(providerName)}\\s*:\\s*$`);

	let inProviders = false;
	let providerIndent = -1;
	let inTargetBlock = false;
	let baseUrl: string | undefined;
	let apiKey: ApiKeyValue | undefined;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line === "" || line.trimStart().startsWith("#")) continue;

		const indent = line.length - line.trimStart().length;

		if (indent === 0) {
			inProviders = /^providers\s*:/.test(line);
			inTargetBlock = false;
			providerIndent = -1;
			continue;
		}

		if (!inProviders) continue;

		if (!inTargetBlock) {
			const headerMatch = providerHeaderRe.exec(line);
			if (headerMatch) {
				inTargetBlock = true;
				providerIndent = headerMatch[1].length;
			}
			continue;
		}

		// Inside the target block. A key at the provider level (same indent)
		// or shallower means we've exited — stop scanning.
		if (indent <= providerIndent) break;

		const kvMatch = line.match(/^\s+(baseUrl|apiKey)\s*:\s*(.*)$/);
		if (!kvMatch) continue;
		const [, key, rawValue] = kvMatch;
		const trimmed = rawValue.trim();

		if (key === "baseUrl") {
			baseUrl = stripQuotes(trimmed);
		} else if (key === "apiKey") {
			apiKey = parseApiKeyValue(trimmed);
		}
	}

	if (baseUrl === undefined && apiKey === undefined) return null;
	return { baseUrl, apiKey };
}

function resolveModelsYmlPath(explicit?: string): string | null {
	if (explicit) return explicit;
	try {
		return path.join(path.dirname(getAgentDbPath()), "models.yml");
	} catch {
		return null;
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}

function parseApiKeyValue(raw: string): ApiKeyValue {
	if (raw.startsWith("!")) return { kind: "shellSecret", raw };
	if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
		const inner = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		return { kind: "literal", value: inner, wasQuoted: true };
	}
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
		return { kind: "literal", value: raw.slice(1, -1), wasQuoted: true };
	}
	if (/^[A-Z][A-Z0-9_]+$/.test(raw)) return { kind: "envVar", name: raw };
	return { kind: "literal", value: raw, wasQuoted: false };
}

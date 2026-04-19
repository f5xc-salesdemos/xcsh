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
 *
 * The parser pins two indent levels once it enters the `providers:` section:
 *
 *   - `providersChildIndent` — the column where provider names live. A line
 *     only qualifies as a provider header when its indent matches this level,
 *     so a nested `anthropic:` inside another provider's sub-map is ignored.
 *   - `fieldIndent` — the column of the first key-value line inside the
 *     target block. Only lines at exactly this indent are considered for
 *     `baseUrl` / `apiKey`, so deeper nested maps (e.g. `discovery:`) cannot
 *     leak values back into the target block.
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
	const providerHeaderRe = new RegExp(`^\\s*${escapeRegex(providerName)}\\s*:\\s*$`);

	let inProviders = false;
	let providersChildIndent = -1;
	let _providerIndent = -1;
	let fieldIndent = -1;
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
			providersChildIndent = -1;
			_providerIndent = -1;
			fieldIndent = -1;
			continue;
		}

		if (!inProviders) continue;

		// First indented child fixes the provider-name indent level.
		if (providersChildIndent === -1) providersChildIndent = indent;

		// A line at the provider-name indent is always a provider header,
		// and it ends the previous target block (if any).
		if (indent === providersChildIndent) {
			inTargetBlock = providerHeaderRe.test(line);
			_providerIndent = inTargetBlock ? indent : -1;
			fieldIndent = -1;
			continue;
		}

		if (!inTargetBlock) continue;

		// Pin field indent on the first in-block line; reject anything deeper.
		if (fieldIndent === -1) fieldIndent = indent;
		if (indent !== fieldIndent) continue;

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

/**
 * Env-var reference heuristic: all-caps identifier with at least one
 * underscore. The underscore requirement is what distinguishes a reference
 * like `LITELLM_API_KEY` from a hand-edited unquoted literal such as
 * `SK12345`, which would otherwise be silently resolved via `process.env`
 * and almost always come back undefined.
 */
function looksLikeEnvVarName(s: string): boolean {
	return /^[A-Z][A-Z0-9_]*$/.test(s) && s.includes("_");
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
	if (looksLikeEnvVarName(raw)) return { kind: "envVar", name: raw };
	return { kind: "literal", value: raw, wasQuoted: false };
}

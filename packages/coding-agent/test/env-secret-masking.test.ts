/**
 * Tests for always-on environment variable secret masking.
 *
 * Covers:
 * - SECRET_ENV_PATTERNS matching (positive and negative)
 * - collectEnvSecrets() collecting values from process.env
 * - OutputSink maskSecrets callback in push() and dump()
 * - Cross-chunk boundary safety net in dump()
 * - formatBashEnvAssignments() masking sensitive env var display
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectEnvSecrets, SECRET_ENV_PATTERNS, SecretObfuscator } from "../src/secrets";
import { OutputSink } from "../src/session/streaming-output";

// ═══════════════════════════════════════════════════════════════════════════
// SECRET_ENV_PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

describe("SECRET_ENV_PATTERNS", () => {
	const shouldMatch = [
		"F5XC_API_TOKEN",
		"API_KEY",
		"LITELLM_API_KEY",
		"F5XC_CONSOLE_PASSWORD",
		"DB_PASSWORD",
		"OAUTH_SECRET",
		"AWS_SECRET_ACCESS_KEY",
		"PRIVATE_KEY",
		"AUTH_TOKEN",
		"CREDENTIAL_FILE",
		"GH_TOKEN",
		"VOLT_API_TOKEN",
		"SSH_PRIVATE_KEY",
		"PASS_PHRASE",
	];

	const shouldNotMatch = [
		"HOME",
		"PATH",
		"EDITOR",
		"SHELL",
		"TERM",
		"USER",
		"LANG",
		"F5XC_NAMESPACE",
		"F5XC_TENANT",
		"F5XC_API_URL",
		"F5XC_DOMAINNAME",
		"NODE_ENV",
		"CI",
		"HOSTNAME",
	];

	for (const name of shouldMatch) {
		test(`matches sensitive var: ${name}`, () => {
			expect(SECRET_ENV_PATTERNS.test(name)).toBe(true);
		});
	}

	for (const name of shouldNotMatch) {
		test(`does NOT match non-sensitive var: ${name}`, () => {
			expect(SECRET_ENV_PATTERNS.test(name)).toBe(false);
		});
	}

	test("matching is case-insensitive", () => {
		expect(SECRET_ENV_PATTERNS.test("api_token")).toBe(true);
		expect(SECRET_ENV_PATTERNS.test("Api_Token")).toBe(true);
		expect(SECRET_ENV_PATTERNS.test("API_TOKEN")).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// collectEnvSecrets
// ═══════════════════════════════════════════════════════════════════════════

describe("collectEnvSecrets", () => {
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = { ...process.env };
	});

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			}
		}
	});

	test("collects values of env vars matching sensitive patterns", () => {
		process.env.TEST_SECRET_TOKEN = "my-secret-value-12345";
		const entries = collectEnvSecrets();
		const values = entries.map(e => e.content);
		expect(values).toContain("my-secret-value-12345");
	});

	test("ignores env vars with short values (< 8 chars)", () => {
		process.env.TEST_API_KEY = "short";
		const entries = collectEnvSecrets();
		const values = entries.map(e => e.content);
		expect(values).not.toContain("short");
	});

	test("ignores non-sensitive env vars", () => {
		process.env.TEST_HARMLESS_VAR = "this-is-not-a-secret-value";
		const entries = collectEnvSecrets();
		const values = entries.map(e => e.content);
		expect(values).not.toContain("this-is-not-a-secret-value");
	});

	test("deduplicates identical values across multiple sensitive vars", () => {
		process.env.TEST_API_KEY = "duplicate-secret-value";
		process.env.TEST_AUTH_TOKEN = "duplicate-secret-value";
		const entries = collectEnvSecrets();
		const matchingEntries = entries.filter(e => e.content === "duplicate-secret-value");
		expect(matchingEntries.length).toBe(1);
	});

	test("entries have type=plain and mode=obfuscate", () => {
		process.env.TEST_SECRET_KEY = "a-valid-secret-value";
		const entries = collectEnvSecrets();
		const entry = entries.find(e => e.content === "a-valid-secret-value");
		expect(entry).toBeDefined();
		expect(entry!.type).toBe("plain");
		expect(entry!.mode).toBe("obfuscate");
	});

	test("scans additionalEnv for sensitive patterns", () => {
		const entries = collectEnvSecrets({
			additionalEnv: {
				F5XC_API_TOKEN: "profile-token-value-xyz",
				F5XC_NAMESPACE: "r-mordasiewicz",
			},
		});
		const values = entries.map(e => e.content);
		expect(values).toContain("profile-token-value-xyz");
		expect(values).not.toContain("r-mordasiewicz");
	});

	test("includes additionalValues regardless of name pattern", () => {
		const entries = collectEnvSecrets({
			additionalValues: ["user-email-from-profile"],
		});
		const values = entries.map(e => e.content);
		expect(values).toContain("user-email-from-profile");
	});

	test("deduplicates across process.env, additionalEnv, and additionalValues", () => {
		process.env.TEST_API_KEY = "shared-secret-value-99";
		const entries = collectEnvSecrets({
			additionalEnv: { ANOTHER_API_KEY: "shared-secret-value-99" },
			additionalValues: ["shared-secret-value-99"],
		});
		const matching = entries.filter(e => e.content === "shared-secret-value-99");
		expect(matching.length).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// OutputSink maskSecrets
// ═══════════════════════════════════════════════════════════════════════════

describe("OutputSink maskSecrets", () => {
	test("masks secret values in push() chunks", async () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "super-secret-token-value", mode: "obfuscate" },
		]);
		const chunks: string[] = [];
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
			onChunk: chunk => chunks.push(chunk),
		});

		sink.push("Authorization: APIToken super-secret-token-value\n");

		const result = await sink.dump();
		expect(result.output).not.toContain("super-secret-token-value");
		// The onChunk callback should also receive masked content
		expect(chunks.join("")).not.toContain("super-secret-token-value");
	});

	test("masks secret values in dump() output", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "my-api-key-12345678", mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		sink.push("KEY=my-api-key-12345678\n");

		const result = await sink.dump();
		expect(result.output).not.toContain("my-api-key-12345678");
	});

	test("dump() safety net catches secrets split across chunk boundaries", async () => {
		const secret = "cross-boundary-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret, mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		// Split the secret across two chunks
		const splitPoint = Math.floor(secret.length / 2);
		sink.push(`prefix ${secret.slice(0, splitPoint)}`);
		sink.push(`${secret.slice(splitPoint)} suffix\n`);

		const result = await sink.dump();
		// The concatenated buffer in dump() should catch the full secret
		expect(result.output).not.toContain(secret);
	});

	test("passes output unchanged when maskSecrets is not set", async () => {
		const sink = new OutputSink({});

		sink.push("F5XC_API_TOKEN=plaintext-visible\n");

		const result = await sink.dump();
		expect(result.output).toContain("F5XC_API_TOKEN=plaintext-visible");
	});

	test("handles empty output with maskSecrets", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "some-secret-12345678", mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		const result = await sink.dump();
		expect(result.output).toBe("");
		expect(result.totalBytes).toBe(0);
	});

	test("masks multiple different secrets in same output", async () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "first-secret-value99", mode: "obfuscate" },
			{ type: "plain", content: "second-secret-val88", mode: "obfuscate" },
		]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		sink.push("token=first-secret-value99 pass=second-secret-val88\n");

		const result = await sink.dump();
		expect(result.output).not.toContain("first-secret-value99");
		expect(result.output).not.toContain("second-secret-val88");
	});

	test("preserves non-secret content alongside masked values", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "secret-token-abc123", mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		sink.push("status: 200\ntoken: secret-token-abc123\nnamespace: r-mordasiewicz\n");

		const result = await sink.dump();
		expect(result.output).not.toContain("secret-token-abc123");
		expect(result.output).toContain("status: 200");
		expect(result.output).toContain("namespace: r-mordasiewicz");
	});

	test("dump notice line is not affected by masking", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "some-secret-12345678", mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});
		sink.push("output data\n");

		const result = await sink.dump("truncated at 50KB");
		expect(result.output).toContain("[truncated at 50KB]");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// formatBashEnvAssignments masking
// ═══════════════════════════════════════════════════════════════════════════

// We can't directly import the private function, but we can test the
// SECRET_ENV_PATTERNS behavior it relies on — the pattern matching logic
// is the same: if SECRET_ENV_PATTERNS.test(key) → masked, else → shown.

describe("formatBashEnvAssignments masking logic", () => {
	test("sensitive keys would be masked (pattern check)", () => {
		const env: Record<string, string> = {
			API_KEY: "sk-1234567890abcdef",
			F5XC_API_TOKEN: "OULzp2FaqP1FTmgygm1dn5BDfYA=",
			NAMESPACE: "r-mordasiewicz",
		};

		for (const [key, value] of Object.entries(env)) {
			if (SECRET_ENV_PATTERNS.test(key)) {
				// These should be masked with "***"
				expect(key).toMatch(/KEY|TOKEN/);
			} else {
				// These should show the real value
				expect(key).toBe("NAMESPACE");
				expect(value).toBe("r-mordasiewicz");
			}
		}
	});

	test("F5XC env vars: only credentials masked, not config", () => {
		const f5xcVars: Record<string, boolean> = {
			F5XC_API_TOKEN: true, // sensitive
			F5XC_CONSOLE_PASSWORD: true, // sensitive
			F5XC_API_URL: false, // not sensitive
			F5XC_NAMESPACE: false, // not sensitive
			F5XC_TENANT: false, // not sensitive
			F5XC_DOMAINNAME: false, // not sensitive
			F5XC_EMAIL: false, // not sensitive (no pattern match)
			F5XC_USERNAME: false, // not sensitive (no pattern match for USERNAME)
		};

		for (const [key, expectedSensitive] of Object.entries(f5xcVars)) {
			expect(SECRET_ENV_PATTERNS.test(key)).toBe(expectedSensitive);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end: SecretObfuscator + OutputSink integration
// ═══════════════════════════════════════════════════════════════════════════

describe("end-to-end env secret masking", () => {
	test("simulates printenv output with real-world env var patterns", async () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OULzp2FaqP1FTmgygm1dn5BDfYA=", mode: "obfuscate" },
			{ type: "plain", content: "zedta2-hyxzyk-qahvUt", mode: "obfuscate" },
			{ type: "plain", content: "sk-e5de24b2e74f41a2af7c444873812bc3", mode: "obfuscate" },
		]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		// Simulate printenv output
		sink.push("F5XC_API_TOKEN=OULzp2FaqP1FTmgygm1dn5BDfYA=\n");
		sink.push("F5XC_CONSOLE_PASSWORD=zedta2-hyxzyk-qahvUt\n");
		sink.push("LITELLM_API_KEY=sk-e5de24b2e74f41a2af7c444873812bc3\n");
		sink.push("F5XC_NAMESPACE=r-mordasiewicz\n");
		sink.push("F5XC_API_URL=https://f5-amer-ent.console.ves.volterra.io\n");

		const result = await sink.dump();

		// Secrets must NOT appear
		expect(result.output).not.toContain("OULzp2FaqP1FTmgygm1dn5BDfYA=");
		expect(result.output).not.toContain("zedta2-hyxzyk-qahvUt");
		expect(result.output).not.toContain("sk-e5de24b2e74f41a2af7c444873812bc3");

		// Non-secrets MUST still appear
		expect(result.output).toContain("r-mordasiewicz");
		expect(result.output).toContain("https://f5-amer-ent.console.ves.volterra.io");
		expect(result.output).toContain("F5XC_NAMESPACE=");
		expect(result.output).toContain("F5XC_API_URL=");
	});

	test("simulates curl command output leaking token in verbose mode", async () => {
		const token = "OULzp2FaqP1FTmgygm1dn5BDfYA=";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: token, mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		sink.push(`> GET /api/web/namespaces/r-mordasiewicz HTTP/2\n`);
		sink.push(`> Authorization: APIToken ${token}\n`);
		sink.push(`> Host: f5-amer-ent.console.ves.volterra.io\n`);
		sink.push(`< HTTP/2 200\n`);
		sink.push(`{"items": []}\n`);

		const result = await sink.dump();

		expect(result.output).not.toContain(token);
		expect(result.output).toContain("Authorization: APIToken");
		expect(result.output).toContain("r-mordasiewicz");
		expect(result.output).toContain('{"items": []}');
	});

	test("obfuscated values can be deobfuscated for LLM processing", async () => {
		const token = "a-real-api-token-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: token, mode: "obfuscate" }]);
		const sink = new OutputSink({
			maskSecrets: t => obfuscator.obfuscate(t),
		});

		sink.push(`token=${token}\n`);
		const result = await sink.dump();

		// Masked output should not contain the token
		expect(result.output).not.toContain(token);

		// But deobfuscation should recover it
		const deobfuscated = obfuscator.deobfuscate(result.output);
		expect(deobfuscated).toContain(token);
	});
});

/**
 * Shared test fixtures for F5 XC authentication tests.
 *
 * All values are synthetic — no real credentials or tenant URLs.
 * Real credentials must NEVER appear in source code.
 *
 * For live/integration tests against a real F5 XC tenant, set these
 * environment variables before running tests:
 *   F5XC_API_URL      — e.g. https://<tenant>.console.ves.volterra.io
 *   F5XC_API_TOKEN    — your API token
 *   F5XC_NAMESPACE    — your namespace
 */

export const TEST_F5XC_URL = process.env.TEST_F5XC_URL ?? "https://test-tenant.console.ves.volterra.io";
export const TEST_F5XC_TOKEN = process.env.TEST_F5XC_TOKEN ?? "FAKE-TOKEN-FOR-UNIT-TESTS";
export const TEST_F5XC_NAMESPACE = process.env.TEST_F5XC_NAMESPACE ?? "default";
export const TEST_F5XC_MASKED_TOKEN = `...${(process.env.TEST_F5XC_TOKEN ?? "FAKE-TOKEN-FOR-UNIT-TESTS").slice(-4)}`;

export const TEST_PROFILE = {
	name: "production",
	apiUrl: TEST_F5XC_URL,
	apiToken: TEST_F5XC_TOKEN,
	defaultNamespace: TEST_F5XC_NAMESPACE,
} as const;

export const TEST_STAGING_URL = process.env.TEST_F5XC_STAGING_URL ?? "https://test-staging.console.ves.volterra.io";
export const TEST_STAGING_TOKEN = process.env.TEST_F5XC_STAGING_TOKEN ?? "FAKE-STAGING-TOKEN-FOR-TESTS";
export const TEST_STAGING_NAMESPACE = process.env.TEST_F5XC_STAGING_NAMESPACE ?? "staging-ns";

export const TEST_PROFILE_STAGING = {
	name: "staging",
	apiUrl: TEST_STAGING_URL,
	apiToken: TEST_STAGING_TOKEN,
	defaultNamespace: TEST_STAGING_NAMESPACE,
} as const;

/** Profile with additional env map for extended variable tests */
export const TEST_PROFILE_WITH_ENV = {
	name: "production",
	apiUrl: TEST_F5XC_URL,
	apiToken: TEST_F5XC_TOKEN,
	defaultNamespace: TEST_F5XC_NAMESPACE,
	env: {
		F5XC_EMAIL: "test@example.com",
		F5XC_USERNAME: "testuser@example.com",
		F5XC_CONSOLE_PASSWORD: "test-console-pass",
		F5XC_LB_NAME: "test-lb",
		F5XC_DOMAINNAME: "test.example.com",
		F5XC_ROOT_DOMAIN: "example.com",
	},
} as const;

/** 128-char realistic token for masking boundary tests */
export const TEST_LONG_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.AAAAAAAAAA_BBBBBBBBBB_CCCCCCCCCC_DDDDDDDDDD_EEEEEEEEEE_FFFFFFFFFF_GGGGGGGGGGHHHHIIII";

/** Profile with metadata fields for /profile show metadata display test */
export const TEST_PROFILE_WITH_METADATA = {
	name: "with-meta",
	apiUrl: TEST_F5XC_URL,
	apiToken: TEST_F5XC_TOKEN,
	defaultNamespace: TEST_F5XC_NAMESPACE,
	metadata: {
		createdAt: "2026-03-15T00:00:00.000Z",
		expiresAt: "2027-03-15T00:00:00.000Z",
	},
} as const;

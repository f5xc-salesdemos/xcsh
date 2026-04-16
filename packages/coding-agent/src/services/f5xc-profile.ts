import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@f5xc-salesdemos/pi-utils";
import { Settings } from "../config/settings";
import { SECRET_ENV_PATTERNS } from "../secrets/index";

export interface F5XCProfile {
	name: string;
	apiUrl: string;
	apiToken: string;
	defaultNamespace: string;
	env?: Record<string, string>;
	/** Env var names from `env` whose values should be masked in output (e.g. ["F5XC_USERNAME"]). */
	sensitiveKeys?: string[];
	metadata?: {
		createdAt?: string;
		expiresAt?: string;
		lastRotatedAt?: string;
		rotateAfterDays?: number;
	};
}

export type AuthStatus = "connected" | "auth_error" | "offline" | "unknown";

export interface ProfileStatus {
	activeProfileName: string | null;
	activeProfileUrl: string | null;
	activeProfileTenant: string | null;
	activeProfileNamespace: string | null;
	credentialSource: "profile" | "environment" | "mixed" | "none";
	authStatus: AuthStatus;
	isConfigured: boolean;
	watcherActive: boolean;
}

export class ProfileError extends Error {
	constructor(
		message: string,
		readonly profileName?: string,
	) {
		super(message);
		this.name = "ProfileError";
	}
}

export class ProfileService {
	static #instance: ProfileService | null = null;
	static #onProfileChangeListeners: Array<(profile: F5XCProfile) => void> = [];

	/** Register a callback invoked after a profile is activated or its settings applied. */
	static onProfileChange(cb: (profile: F5XCProfile) => void): void {
		ProfileService.#onProfileChangeListeners.push(cb);
	}

	#configDir: string;
	#activeProfile: F5XCProfile | null = null;
	#credentialSource: ProfileStatus["credentialSource"] = "none";
	#authStatus: AuthStatus = "unknown";

	private constructor(configDir: string) {
		this.#configDir = configDir;
	}

	static init(configDir: string): ProfileService {
		ProfileService.#instance = new ProfileService(configDir);
		return ProfileService.#instance;
	}

	/**
	 * Return the values of env vars marked as sensitive in the active profile.
	 * Safe to call before init — returns empty array if no profile is loaded.
	 */
	static getSensitiveProfileValues(): string[] {
		const instance = ProfileService.#instance;
		if (!instance) return [];
		const profile = instance.#activeProfile;
		if (!profile?.sensitiveKeys?.length || !profile.env) return [];
		const values: string[] = [];
		for (const key of profile.sensitiveKeys) {
			const value = profile.env[key];
			if (value) values.push(value);
		}
		return values;
	}

	static get instance(): ProfileService {
		if (!ProfileService.#instance) {
			throw new Error("ProfileService not initialized. Call ProfileService.init() first.");
		}
		return ProfileService.#instance;
	}

	static _resetForTest(): void {
		ProfileService.#instance = null;
	}

	get profilesDir(): string {
		return path.join(this.#configDir, "profiles");
	}

	get activeProfilePath(): string {
		return path.join(this.#configDir, "active_profile");
	}

	async loadActive(): Promise<F5XCProfile | null> {
		// FR-102: F5XC_API_URL is the signal to skip profile loading entirely.
		// Subprocesses inherit process.env, so they already see the env vars directly.
		if (process.env.F5XC_API_URL) {
			this.#credentialSource = "environment";
			return null;
		}

		// Check if config dir exists
		if (!fs.existsSync(this.#configDir)) {
			return null;
		}

		let profileName = this.#readActiveProfileName();

		// FR-104: auto-activate if exactly one profile exists
		let autoActivated = false;
		if (!profileName) {
			const profiles = this.#listProfileFiles();
			if (profiles.length === 1) {
				profileName = profiles[0].replace(/\.json$/, "");
				autoActivated = true;
			} else {
				return null;
			}
		}

		// Read the profile JSON
		const profile = this.#readProfile(profileName);
		if (!profile) {
			return null;
		}

		// Only persist active_profile after the profile validates
		if (autoActivated) {
			this.#atomicWrite(this.activeProfilePath, profileName);
			logger.debug("F5XC: auto-activated single profile", { name: profileName });
		}

		this.#activeProfile = profile;
		this.#applyToSettings(profile);
		// Detect mixed source: profile loaded but some fields come from process.env
		const hasEnvOverride = !!process.env.F5XC_API_TOKEN || !!process.env.F5XC_NAMESPACE;
		this.#credentialSource = hasEnvOverride ? "mixed" : "profile";
		return profile;
	}

	async activate(name: string): Promise<F5XCProfile> {
		// Reject activation when env overrides are present — would create mismatched credentials
		if (process.env.F5XC_API_URL) {
			throw new ProfileError(
				"Cannot activate a profile while F5XC_API_URL is set in the environment. " +
					"Unset F5XC_API_URL first, or restart xcsh without it.",
			);
		}

		this.#validateProfileName(name);
		const profile = this.#readProfile(name);
		if (!profile) {
			throw new ProfileError(`Profile '${name}' not found.`, name);
		}

		// NFR-402: write active_profile first — if it fails, don't update settings
		this.#atomicWrite(this.activeProfilePath, name);

		this.#activeProfile = profile;
		this.#applyToSettings(profile);
		const hasEnvOverride = !!process.env.F5XC_API_TOKEN || !!process.env.F5XC_NAMESPACE;
		this.#credentialSource = hasEnvOverride ? "mixed" : "profile";
		return profile;
	}

	async listProfiles(): Promise<F5XCProfile[]> {
		const files = this.#listProfileFiles();
		const profiles: F5XCProfile[] = [];
		for (const file of files) {
			const name = file.replace(/\.json$/, "");
			const profile = this.#readProfile(name);
			if (profile) {
				profiles.push(profile);
			}
		}
		return profiles;
	}

	async createProfile(profile: Omit<F5XCProfile, "metadata">): Promise<void> {
		this.#validateProfileName(profile.name);
		const profilePath = path.join(this.profilesDir, `${profile.name}.json`);
		if (fs.existsSync(profilePath)) {
			throw new ProfileError(`Profile '${profile.name}' already exists.`, profile.name);
		}
		fs.mkdirSync(this.profilesDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.#configDir, { recursive: true, mode: 0o700 });
		const data: F5XCProfile = {
			...profile,
			metadata: { createdAt: new Date().toISOString() },
		};
		const tmpPath = `${profilePath}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
		fs.renameSync(tmpPath, profilePath);
	}

	async deleteProfile(name: string): Promise<void> {
		this.#validateProfileName(name);
		const profilePath = path.join(this.profilesDir, `${name}.json`);
		if (!fs.existsSync(profilePath)) {
			throw new ProfileError(`Profile '${name}' not found.`, name);
		}
		fs.unlinkSync(profilePath);
	}

	/** Add or update environment variables on a profile. Keys matching secret
	 *  naming patterns are automatically added to sensitiveKeys. */
	async setEnvVars(name: string, vars: Record<string, string>): Promise<{ sensitive: string[] }> {
		this.#validateProfileName(name);
		const profile = this.#readProfile(name);
		if (!profile) throw new ProfileError(`Profile '${name}' not found.`, name);

		const env = { ...(profile.env ?? {}), ...vars };
		const sensitiveSet = new Set(profile.sensitiveKeys ?? []);
		const newSensitive: string[] = [];
		for (const key of Object.keys(vars)) {
			if (SECRET_ENV_PATTERNS.test(key) && !sensitiveSet.has(key)) {
				sensitiveSet.add(key);
				newSensitive.push(key);
			}
		}
		// Remove sensitiveKeys entries for keys no longer in env
		const sensitiveKeys = [...sensitiveSet].filter(k => k in env);

		const updated: F5XCProfile = {
			...profile,
			env,
			sensitiveKeys: sensitiveKeys.length > 0 ? sensitiveKeys : undefined,
		};
		const profilePath = path.join(this.profilesDir, `${name}.json`);
		this.#atomicWrite(profilePath, JSON.stringify(updated, null, 2));

		if (this.#activeProfile?.name === name) {
			this.#activeProfile = updated;
			this.#applyToSettings(updated);
		}
		return { sensitive: newSensitive };
	}

	/** Remove environment variables from a profile. Also removes them from sensitiveKeys. */
	async unsetEnvVars(name: string, keys: string[]): Promise<{ removed: string[] }> {
		this.#validateProfileName(name);
		const profile = this.#readProfile(name);
		if (!profile) throw new ProfileError(`Profile '${name}' not found.`, name);

		const env = { ...(profile.env ?? {}) };
		const removed: string[] = [];
		for (const key of keys) {
			if (key in env) {
				delete env[key];
				removed.push(key);
			}
		}
		if (removed.length === 0) return { removed: [] };

		const keySet = new Set(keys);
		const sensitiveKeys = (profile.sensitiveKeys ?? []).filter(k => !keySet.has(k) && k in env);
		const envOrUndefined = Object.keys(env).length > 0 ? env : undefined;

		const updated: F5XCProfile = {
			...profile,
			env: envOrUndefined,
			sensitiveKeys: sensitiveKeys.length > 0 ? sensitiveKeys : undefined,
		};
		const profilePath = path.join(this.profilesDir, `${name}.json`);
		this.#atomicWrite(profilePath, JSON.stringify(updated, null, 2));

		if (this.#activeProfile?.name === name) {
			this.#activeProfile = updated;
			this.#applyToSettings(updated);
		}
		return { removed };
	}

	async validateToken(options?: {
		timeoutMs?: number;
		apiUrl?: string;
		apiToken?: string;
	}): Promise<{ status: AuthStatus; latencyMs?: number }> {
		// Use explicit credentials if provided (for non-active profiles or env-backed sessions),
		// otherwise fall back to effective credentials (env override > active profile)
		const effectiveUrl = options?.apiUrl ?? process.env.F5XC_API_URL ?? this.#activeProfile?.apiUrl;
		const effectiveToken = options?.apiToken ?? process.env.F5XC_API_TOKEN ?? this.#activeProfile?.apiToken;
		if (!effectiveUrl || !effectiveToken) return { status: "unknown" };
		const url = `${effectiveUrl}/api/web/namespaces`;
		const timeout = options?.timeoutMs ?? 3000;
		try {
			const start = performance.now();
			const response = await fetch(url, {
				method: "GET",
				headers: { Authorization: `APIToken ${effectiveToken}`, Accept: "application/json" },
				signal: AbortSignal.timeout(timeout),
			});
			const latencyMs = Math.round(performance.now() - start);
			if (response.ok) {
				this.#authStatus = "connected";
				return { status: "connected", latencyMs };
			}
			if (response.status === 401 || response.status === 403) {
				this.#authStatus = "auth_error";
				return { status: "auth_error", latencyMs };
			}
			this.#authStatus = "connected";
			return { status: "connected", latencyMs };
		} catch {
			this.#authStatus = "offline";
			return { status: "offline" };
		}
	}

	setNamespace(namespace: string): void {
		if (!this.#activeProfile) {
			throw new ProfileError("No active profile. Activate a profile first.");
		}
		this.#activeProfile = { ...this.#activeProfile, defaultNamespace: namespace };
		// Re-apply settings with the new namespace
		this.#applyToSettings(this.#activeProfile);
		const hasEnvOverride = !!process.env.F5XC_API_TOKEN || !!process.env.F5XC_NAMESPACE;
		this.#credentialSource = hasEnvOverride ? "mixed" : "profile";
	}

	getStatus(): ProfileStatus {
		const url = process.env.F5XC_API_URL ?? this.#activeProfile?.apiUrl ?? null;
		let tenant: string | null = null;
		if (url) {
			try {
				tenant = new URL(url).hostname.split(".")[0];
			} catch {
				/* invalid URL */
			}
		}
		return {
			activeProfileName: this.#activeProfile?.name ?? null,
			activeProfileUrl: url,
			activeProfileTenant: tenant,
			activeProfileNamespace: process.env.F5XC_NAMESPACE ?? this.#activeProfile?.defaultNamespace ?? null,
			credentialSource: this.#credentialSource,
			authStatus: this.#authStatus,
			isConfigured: this.#credentialSource !== "none",
			watcherActive: false,
		};
	}

	maskToken(token: string): string {
		if (token.length <= 4) return "****";
		return `...${token.slice(-4)}`;
	}

	// --- Private helpers ---

	#atomicWrite(filePath: string, content: string): void {
		const tmpPath = `${filePath}.tmp`;
		fs.writeFileSync(tmpPath, content);
		fs.renameSync(tmpPath, filePath);
	}

	#validateProfileName(name: string): void {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
			throw new ProfileError(
				`Invalid profile name: '${name}'. Names must be alphanumeric with dashes/underscores, max 64 chars.`,
				name,
			);
		}
	}

	#readActiveProfileName(): string | null {
		try {
			if (!fs.existsSync(this.activeProfilePath)) return null;
			const name = fs.readFileSync(this.activeProfilePath, "utf-8").trim();
			if (!name) return null;
			// Validate to prevent path traversal from crafted active_profile files
			if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
				logger.warn("F5XC active_profile contains invalid name", { name });
				return null;
			}
			return name;
		} catch {
			return null;
		}
	}

	#readProfile(name: string): F5XCProfile | null {
		const filePath = path.join(this.profilesDir, `${name}.json`);
		try {
			if (!fs.existsSync(filePath)) {
				logger.warn("F5XC profile file not found", { name, path: filePath });
				return null;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(content);

			// Validate required fields exist and are strings
			if (
				!parsed.apiUrl ||
				typeof parsed.apiUrl !== "string" ||
				!parsed.apiToken ||
				typeof parsed.apiToken !== "string"
			) {
				logger.warn("F5XC profile missing or invalid required fields", { name });
				return null;
			}
			if (parsed.defaultNamespace && typeof parsed.defaultNamespace !== "string") {
				logger.warn("F5XC profile has non-string defaultNamespace", { name });
				return null;
			}

			// Read optional env map — accept only string values
			let env: Record<string, string> | undefined;
			if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
				env = {};
				for (const [k, v] of Object.entries(parsed.env)) {
					if (typeof v === "string") env[k] = v;
				}
				if (Object.keys(env).length === 0) env = undefined;
			}

			// Read optional sensitiveKeys — accept only string[] with keys present in env
			let sensitiveKeys: string[] | undefined;
			if (Array.isArray(parsed.sensitiveKeys) && env) {
				const filtered = parsed.sensitiveKeys.filter(
					(k: unknown): k is string => typeof k === "string" && k in env,
				);
				sensitiveKeys = filtered.length > 0 ? filtered : undefined;
			}

			return {
				name, // Canonical identity is the filename, not parsed.name
				apiUrl: parsed.apiUrl,
				apiToken: parsed.apiToken,
				defaultNamespace: parsed.defaultNamespace ?? "default",
				env,
				sensitiveKeys,
				metadata: parsed.metadata,
			};
		} catch (err) {
			logger.warn("F5XC profile read error", { name, error: String(err) });
			return null;
		}
	}

	#listProfileFiles(): string[] {
		try {
			if (!fs.existsSync(this.profilesDir)) return [];
			return fs.readdirSync(this.profilesDir).filter(f => f.endsWith(".json"));
		} catch {
			return [];
		}
	}

	#applyToSettings(profile: F5XCProfile): void {
		// Per-field merge: skip any key already in process.env (subprocess inherits
		// it directly), inject profile values for the rest. This avoids both
		// overriding explicit env vars AND losing profile values for unset keys.
		const existing = (Settings.instance.get("bash.environment") ?? {}) as Record<string, string>;
		// Preserve non-F5XC keys (user-defined HTTP_PROXY, PATH, etc.) but clear
		// all F5XC_* keys to prevent stale credentials leaking across profile switches
		const merged: Record<string, string> = {};
		for (const [key, value] of Object.entries(existing)) {
			if (!key.startsWith("F5XC_")) merged[key] = value;
		}
		if (!process.env.F5XC_API_URL) merged.F5XC_API_URL = profile.apiUrl;
		if (!process.env.F5XC_API_TOKEN) merged.F5XC_API_TOKEN = profile.apiToken;
		if (!process.env.F5XC_NAMESPACE) merged.F5XC_NAMESPACE = profile.defaultNamespace;

		// Auto-derive F5XC_TENANT from first hostname label of apiUrl
		if (!process.env.F5XC_TENANT) {
			try {
				merged.F5XC_TENANT = new URL(profile.apiUrl).hostname.split(".")[0];
			} catch {
				/* invalid URL — skip */
			}
		}

		// Inject all additional env vars from profile.env map
		if (profile.env) {
			for (const [key, value] of Object.entries(profile.env)) {
				if (!process.env[key]) merged[key] = value;
			}
		}

		Settings.instance.override("bash.environment", merged);

		// Notify listeners (e.g. obfuscator refresh) about the profile change.
		for (const cb of ProfileService.#onProfileChangeListeners) {
			cb(profile);
		}
	}
}

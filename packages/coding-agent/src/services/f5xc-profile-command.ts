import * as os from "node:os";
import * as path from "node:path";
import { SECRET_ENV_PATTERNS } from "../secrets/index";
import { ProfileError, ProfileService } from "./f5xc-profile";
import { formatAuthIndicator, renderF5XCTable, type TableRow } from "./f5xc-table";

interface CommandContext {
	showStatus(msg: string): void;
	showError(msg: string): void;
	editor: { setText(text: string): void };
	statusLine?: { invalidate(): void };
	updateEditorTopBorder?(): void;
	ui?: { requestRender(): void };
}

async function getOrInitService(): Promise<ProfileService> {
	try {
		return ProfileService.instance;
	} catch {
		// Lazy init for SDK/embedder paths where main.ts startup didn't run
		const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
		const service = ProfileService.init(path.join(xdgConfig, "f5xc"));
		await service.loadActive();
		return service;
	}
}

export async function handleProfileCommand(
	command: { name: string; args: string; text: string },
	ctx: CommandContext,
): Promise<void> {
	const [sub, ...rest] = command.args.trim().split(/\s+/);
	const arg = rest.join(" ");
	const service = await getOrInitService();

	ctx.editor.setText("");

	switch (sub?.toLowerCase()) {
		case "list":
		case undefined:
		case "":
			return handleList(ctx, service);
		case "activate":
			return handleActivate(ctx, service, arg);
		case "show":
			return handleShow(ctx, service, arg);
		case "status":
			return handleStatus(ctx, service);
		case "create":
			return handleCreate(ctx, service, rest);
		case "delete":
			return handleDelete(ctx, service, rest);
		case "namespace":
			return handleNamespace(ctx, service, arg);
		case "env":
			return handleEnvSubcommand(ctx, service, rest);
		case "set":
		case "add":
			return handleEnvSet(ctx, service, arg);
		case "unset":
		case "remove":
		case "clear":
			return handleEnvUnset(ctx, service, arg);
		default:
			// Natural language fallback: detect KEY=VALUE patterns
			if (ENV_SET_PATTERN.test(command.args)) {
				return handleEnvSet(ctx, service, command.args);
			}
			ctx.showError(
				`Unknown subcommand: ${sub}. Use /profile list|activate|show|status|create|delete|namespace|env|set|unset`,
			);
	}
}

/** Strip control characters to prevent TUI corruption from malformed profile JSON */
function sanitize(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, "");
}

async function handleList(ctx: CommandContext, service: ProfileService): Promise<void> {
	const profiles = await service.listProfiles();
	if (profiles.length === 0) {
		ctx.showStatus("No F5 XC profiles found. Use /profile create or ask me to help set one up.");
		return;
	}
	const status = service.getStatus();
	const lines = profiles.map(p => {
		const marker = p.name === status.activeProfileName ? "*" : " ";
		return `  ${marker} ${sanitize(p.name).padEnd(20)} ${sanitize(p.apiUrl)}`;
	});
	ctx.showStatus(lines.join("\n"));
}

async function handleActivate(ctx: CommandContext, service: ProfileService, name: string): Promise<void> {
	if (!name) {
		ctx.showError("Usage: /profile activate <name>");
		return;
	}
	try {
		await service.activate(name);
		ctx.statusLine?.invalidate();
		ctx.updateEditorTopBorder?.();
		ctx.ui?.requestRender();
		// Show the same red table as /profile show
		return handleShow(ctx, service);
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

function isSensitiveKey(key: string): boolean {
	return SECRET_ENV_PATTERNS.test(key);
}

async function handleShow(ctx: CommandContext, service: ProfileService, name?: string): Promise<void> {
	const targetName = name || service.getStatus().activeProfileName;
	if (!targetName) {
		ctx.showError("No active profile. Use /profile activate <name> first.");
		return;
	}
	const profiles = await service.listProfiles();
	const profile = profiles.find(p => p.name === targetName);
	if (!profile) {
		ctx.showError(`Profile '${targetName}' not found.`);
		return;
	}

	// Derive tenant from URL
	let tenant = "";
	try {
		tenant = new URL(profile.apiUrl).hostname.split(".")[0];
	} catch {
		/* skip */
	}

	// Validate the shown profile's token (not necessarily the active one)
	const auth = await service.validateToken({ timeoutMs: 3000, apiUrl: profile.apiUrl, apiToken: profile.apiToken });

	// Build table rows — auth section first
	const rows: TableRow[] = [
		{ key: "F5XC_TENANT", value: sanitize(tenant) },
		{ key: "F5XC_API_URL", value: sanitize(profile.apiUrl) },
		{ key: "F5XC_API_TOKEN", value: service.maskToken(profile.apiToken) },
	];

	// Auth-related env vars
	const authKeys = ["F5XC_USERNAME", "F5XC_CONSOLE_PASSWORD"];
	for (const key of authKeys) {
		const value = profile.env?.[key];
		if (value) {
			rows.push({ key: sanitize(key), value: isSensitiveKey(key) ? service.maskToken(value) : sanitize(value) });
		}
	}

	// Auth status indicator
	rows.push({ key: "Status", value: formatAuthIndicator(auth.status, auth.latencyMs) });

	// Track where environment section starts
	const envDividerIndex = rows.length;

	// Environment section: namespace + remaining env vars
	rows.push({ key: "F5XC_NAMESPACE", value: sanitize(profile.defaultNamespace) });
	if (profile.env) {
		for (const [key, value] of Object.entries(profile.env)) {
			if (authKeys.includes(key)) continue;
			rows.push({ key: sanitize(key), value: isSensitiveKey(key) ? service.maskToken(value) : sanitize(value) });
		}
	}

	ctx.showStatus(renderF5XCTable(profile.name, rows, { dividerBefore: envDividerIndex }));
}

async function handleStatus(ctx: CommandContext, service: ProfileService): Promise<void> {
	const status = service.getStatus();
	if (!status.isConfigured) {
		ctx.showStatus("F5 XC: not configured. Use /profile create or ask me to help set one up.");
		return;
	}
	const auth = await service.validateToken({ timeoutMs: 3000 });
	const rows: TableRow[] = [
		{ key: "Tenant", value: status.activeProfileTenant ?? "(unknown)" },
		{ key: "Source", value: status.credentialSource },
		{ key: "API URL", value: status.activeProfileUrl ?? "(not set)" },
		{ key: "Namespace", value: status.activeProfileNamespace ?? "(not set)" },
		{ key: "Status", value: formatAuthIndicator(auth.status, auth.latencyMs) },
	];
	ctx.showStatus(renderF5XCTable(status.activeProfileName ?? "status", rows));
}

async function handleCreate(ctx: CommandContext, service: ProfileService, args: string[]): Promise<void> {
	const [name, url, token, namespace] = args;
	if (!name || !url || !token) {
		ctx.showError("Usage: /profile create <name> <url> <token> [namespace]");
		return;
	}
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
		ctx.showError("Profile name must be alphanumeric with dashes/underscores, max 64 chars.");
		return;
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || !parsed.hostname || parsed.hostname.includes(" ")) {
			ctx.showError("API URL must be a valid HTTPS URL (e.g. https://tenant.console.ves.volterra.io)");
			return;
		}
	} catch {
		ctx.showError("API URL must be a valid HTTPS URL (e.g. https://tenant.console.ves.volterra.io)");
		return;
	}
	try {
		await service.createProfile({
			name,
			apiUrl: url,
			apiToken: token,
			defaultNamespace: namespace ?? "default",
		});
		ctx.showStatus(`Profile '${name}' created. Use /profile activate ${name} to switch to it.`);
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

async function handleDelete(ctx: CommandContext, service: ProfileService, args: string[]): Promise<void> {
	const name = args[0];
	const confirmed = args.includes("--confirm");
	if (!name) {
		ctx.showError("Usage: /profile delete <name> --confirm");
		return;
	}
	const status = service.getStatus();
	if (name === status.activeProfileName) {
		ctx.showError("Cannot delete the active profile. Activate a different profile first.");
		return;
	}
	if (!confirmed) {
		ctx.showStatus(
			`This will permanently delete profile '${name}' from ~/.config/f5xc/profiles/.\nRun /profile delete ${name} --confirm to proceed.`,
		);
		return;
	}
	try {
		await service.deleteProfile(name);
		ctx.showStatus(`Profile '${name}' deleted.`);
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

async function handleNamespace(ctx: CommandContext, service: ProfileService, namespace: string): Promise<void> {
	if (!namespace) {
		ctx.showError(
			"Usage: /profile namespace <name>\nSwitches the active namespace without changing the profile. Default is 'default'.",
		);
		return;
	}
	try {
		service.setNamespace(namespace);
		ctx.showStatus(`Namespace switched to: ${namespace}`);
		ctx.statusLine?.invalidate();
		ctx.updateEditorTopBorder?.();
		ctx.ui?.requestRender();
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Environment Variable Management
// ═══════════════════════════════════════════════════════════════════════════

/** Matches KEY=VALUE pairs in freeform text. Keys start with a letter or underscore. */
const ENV_SET_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g;

function parseEnvPairs(text: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const match of text.matchAll(ENV_SET_PATTERN)) {
		vars[match[1]] = match[2];
	}
	return vars;
}

/** Extract bare KEY names (uppercase env-var-style words) from text, filtering out common verbs. */
const NOISE_WORDS = new Set([
	"remove",
	"unset",
	"delete",
	"clear",
	"drop",
	"env",
	"environment",
	"variable",
	"variables",
	"var",
	"vars",
	"from",
	"my",
	"profile",
	"the",
]);

function parseEnvKeys(text: string): string[] {
	return text.split(/\s+/).filter(w => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w) && !NOISE_WORDS.has(w.toLowerCase()));
}

async function handleEnvSubcommand(ctx: CommandContext, service: ProfileService, args: string[]): Promise<void> {
	const [action, ...rest] = args;
	const arg = rest.join(" ");
	switch (action?.toLowerCase()) {
		case "list":
		case undefined:
		case "":
			return handleEnvList(ctx, service);
		case "set":
		case "add":
			return handleEnvSet(ctx, service, arg);
		case "unset":
		case "remove":
		case "delete":
		case "clear":
			return handleEnvUnset(ctx, service, arg);
		default: {
			// If the action itself contains KEY=VALUE, treat the whole thing as a set
			const fullText = [action, ...rest].join(" ");
			if (ENV_SET_PATTERN.test(fullText)) {
				return handleEnvSet(ctx, service, fullText);
			}
			ctx.showError(`Unknown env action: ${action}. Use /profile env set|unset|list`);
		}
	}
}

async function handleEnvList(ctx: CommandContext, service: ProfileService): Promise<void> {
	const status = service.getStatus();
	const profileName = status.activeProfileName;
	if (!profileName) {
		ctx.showError("No active profile. Use /profile activate <name> first.");
		return;
	}
	const profiles = await service.listProfiles();
	const profile = profiles.find(p => p.name === profileName);
	if (!profile?.env || Object.keys(profile.env).length === 0) {
		ctx.showStatus(`Profile '${profileName}' has no custom environment variables.`);
		return;
	}
	const rows: TableRow[] = [];
	for (const [key, value] of Object.entries(profile.env)) {
		const sensitive = isSensitiveKey(key) || (profile.sensitiveKeys ?? []).includes(key);
		rows.push({ key: sanitize(key), value: sensitive ? service.maskToken(value) : sanitize(value) });
	}
	ctx.showStatus(renderF5XCTable(`${profileName} env`, rows));
}

async function handleEnvSet(ctx: CommandContext, service: ProfileService, args: string): Promise<void> {
	const vars = parseEnvPairs(args);
	const keys = Object.keys(vars);
	if (keys.length === 0) {
		ctx.showError("No KEY=VALUE pairs found. Usage: /profile set KEY=VALUE [KEY2=VALUE2 ...]");
		return;
	}
	const status = service.getStatus();
	const profileName = status.activeProfileName;
	if (!profileName) {
		ctx.showError("No active profile. Use /profile activate <name> first.");
		return;
	}
	try {
		const result = await service.setEnvVars(profileName, vars);
		const lines: string[] = [];
		for (const key of keys) {
			const lock = result.sensitive.includes(key) ? " (auto-sensitive)" : "";
			const displayValue = isSensitiveKey(key) ? "***" : vars[key];
			lines.push(`  ${key}=${displayValue}${lock}`);
		}
		ctx.showStatus(
			`Set ${keys.length} variable${keys.length > 1 ? "s" : ""} on '${profileName}':\n${lines.join("\n")}`,
		);
		ctx.statusLine?.invalidate();
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

async function handleEnvUnset(ctx: CommandContext, service: ProfileService, args: string): Promise<void> {
	const keys = parseEnvKeys(args);
	if (keys.length === 0) {
		ctx.showError("No variable names found. Usage: /profile unset KEY [KEY2 ...]");
		return;
	}
	const status = service.getStatus();
	const profileName = status.activeProfileName;
	if (!profileName) {
		ctx.showError("No active profile. Use /profile activate <name> first.");
		return;
	}
	try {
		const result = await service.unsetEnvVars(profileName, keys);
		if (result.removed.length === 0) {
			ctx.showStatus(`No matching variables found on '${profileName}'.`);
			return;
		}
		ctx.showStatus(
			`Removed ${result.removed.length} variable${result.removed.length > 1 ? "s" : ""} from '${profileName}':\n${result.removed.map(k => `  ${k}`).join("\n")}`,
		);
		ctx.statusLine?.invalidate();
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

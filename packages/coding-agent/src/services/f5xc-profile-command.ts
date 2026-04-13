import * as os from "node:os";
import * as path from "node:path";
import { ProfileError, ProfileService } from "./f5xc-profile";

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
		default:
			ctx.showError(
				`Unknown subcommand: ${sub}. Use /profile list|activate|show|status|create|delete`,
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
	const lines = profiles.map((p) => {
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
		const profile = await service.activate(name);
		ctx.showStatus(`Switched to F5 XC profile: ${name} (${profile.apiUrl})`);
		ctx.statusLine?.invalidate();
		ctx.updateEditorTopBorder?.();
		ctx.ui?.requestRender();
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

/** Keys containing these substrings are treated as secrets and masked in output */
const SENSITIVE_KEY_PATTERNS = ["TOKEN", "PASSWORD", "SECRET"];

function isSensitiveKey(key: string): boolean {
	const upper = key.toUpperCase();
	return SENSITIVE_KEY_PATTERNS.some((p) => upper.includes(p));
}

async function handleShow(ctx: CommandContext, service: ProfileService, name?: string): Promise<void> {
	const targetName = name || service.getStatus().activeProfileName;
	if (!targetName) {
		ctx.showError("No active profile. Use /profile activate <name> first.");
		return;
	}
	const profiles = await service.listProfiles();
	const profile = profiles.find((p) => p.name === targetName);
	if (!profile) {
		ctx.showError(`Profile '${targetName}' not found.`);
		return;
	}

	// Derive tenant from URL
	let tenant = "";
	try { tenant = new URL(profile.apiUrl).hostname.split(".")[0]; } catch { /* skip */ }

	const lines = [
		`Profile:      ${sanitize(profile.name)}`,
		`  Tenant:       ${sanitize(tenant)}`,
		`  API URL:      ${sanitize(profile.apiUrl)}`,
		`  API Token:    ${service.maskToken(profile.apiToken)}`,
		`  Namespace:    ${sanitize(profile.defaultNamespace)}`,
	];
	if (profile.metadata?.createdAt) lines.push(`  Created:      ${profile.metadata.createdAt.slice(0, 10)}`);
	if (profile.metadata?.expiresAt) lines.push(`  Expires:      ${profile.metadata.expiresAt.slice(0, 10)}`);

	// Display additional env vars from profile.env
	if (profile.env && Object.keys(profile.env).length > 0) {
		lines.push("  Environment:");
		for (const [key, value] of Object.entries(profile.env)) {
			const display = isSensitiveKey(key) ? service.maskToken(value) : sanitize(value);
			lines.push(`    ${sanitize(key)}: ${display}`);
		}
	}

	ctx.showStatus(lines.join("\n"));
}

async function handleStatus(ctx: CommandContext, service: ProfileService): Promise<void> {
	const status = service.getStatus();
	if (!status.isConfigured) {
		ctx.showStatus("F5 XC: not configured. Use /profile create or ask me to help set one up.");
		return;
	}
	const lines = [
		"F5 XC Authentication Status",
		`  Profile:     ${status.activeProfileName ?? "(none)"}`,
		`  Tenant:      ${status.activeProfileTenant ?? "(unknown)"}`,
		`  Source:      ${status.credentialSource}`,
		`  API URL:     ${status.activeProfileUrl ?? "(not set)"}`,
		`  Namespace:   ${status.activeProfileNamespace ?? "(not set)"}`,
		`  Configured:  yes`,
	];
	ctx.showStatus(lines.join("\n"));
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
		ctx.showStatus(`This will permanently delete profile '${name}' from ~/.config/f5xc/profiles/.\nRun /profile delete ${name} --confirm to proceed.`);
		return;
	}
	try {
		await service.deleteProfile(name);
		ctx.showStatus(`Profile '${name}' deleted.`);
	} catch (err) {
		ctx.showError(err instanceof ProfileError ? err.message : String(err));
	}
}

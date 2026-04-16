import { logger } from "@f5xc-salesdemos/pi-utils";
import type { ApiAuthConfig, ApiOperation, ResolvedAuth } from "./api-types";

export class ApiExecutor {
	resolveAuth(auth: ApiAuthConfig): ResolvedAuth {
		const baseUrl = this.#requireEnv(auth.baseUrlSource);
		const headers: Record<string, string> = {};

		if (auth.type === "api_token" || auth.type === "bearer") {
			const token = this.#requireEnv(auth.tokenSource!);
			const defaultTemplate = auth.type === "bearer" ? "Bearer {token}" : "{token}";
			const headerValue = (auth.headerTemplate ?? defaultTemplate).replace("{token}", token);
			headers[auth.headerName ?? "Authorization"] = headerValue;
		} else if (auth.type === "basic") {
			const username = this.#requireEnv(auth.usernameSource!);
			const password = this.#requireEnv(auth.passwordSource!);
			headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
		} else if (auth.type === "custom") {
			const value = this.#requireEnv(auth.headerValueSource!);
			headers[auth.headerName!] = value;
		}

		return { headers, baseUrl };
	}

	resolveParams(op: ApiOperation, userParams: Record<string, unknown>): Record<string, string> {
		const resolved: Record<string, string> = {};

		for (const [key, value] of Object.entries(userParams)) {
			resolved[key] = String(value);
		}

		for (const param of op.parameters ?? []) {
			if (resolved[param.name] !== undefined) continue;
			if (!param.default) continue;
			if (param.default.startsWith("$")) {
				const envValue = process.env[param.default.slice(1)];
				if (envValue) resolved[param.name] = envValue;
			} else {
				resolved[param.name] = param.default;
			}
		}

		return resolved;
	}

	resolveUrl(
		baseUrl: string,
		pathTemplate: string,
		pathParams: Record<string, string>,
		queryParams?: Record<string, string>,
	): string {
		let resolved = pathTemplate;
		for (const [key, value] of Object.entries(pathParams)) {
			resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
		}
		const url = baseUrl.replace(/\/$/, "") + resolved;
		if (queryParams && Object.keys(queryParams).length > 0) {
			return `${url}?${new URLSearchParams(queryParams).toString()}`;
		}
		return url;
	}

	async execute(
		auth: ResolvedAuth,
		op: ApiOperation,
		resolvedParams: Record<string, string>,
		body?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
		const pathParams: Record<string, string> = {};
		const queryParams: Record<string, string> = {};

		for (const param of op.parameters ?? []) {
			const value = resolvedParams[param.name];
			if (value === undefined) continue;
			if (param.in === "path") pathParams[param.name] = value;
			else if (param.in === "query") queryParams[param.name] = value;
		}

		const url = this.resolveUrl(auth.baseUrl, op.path, pathParams, queryParams);
		const headers: Record<string, string> = { "Content-Type": "application/json", ...auth.headers };
		const init: RequestInit = { method: op.method, headers, signal };

		if (body && ["POST", "PUT", "PATCH"].includes(op.method)) {
			init.body = JSON.stringify(body);
		}

		logger.debug("ApiExecutor: executing request", { method: op.method, url });

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			return { ok: false, status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
		}

		const text = await response.text();
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}

		if (!response.ok) {
			const errMsg =
				typeof data === "object" && data !== null && "message" in data
					? (data as { message: string }).message
					: text;
			logger.debug("ApiExecutor: request failed", { status: response.status, url });
			return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errMsg}` };
		}

		return { ok: true, data };
	}

	#requireEnv(name: string): string {
		const value = process.env[name];
		if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
		return value;
	}
}

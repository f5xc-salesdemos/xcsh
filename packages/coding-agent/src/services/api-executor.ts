import { logger } from "@f5xc-salesdemos/pi-utils";
import type { ApiAuthConfig, ApiOperation, ResolvedAuth } from "./api-types";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface CacheEntry {
	data: unknown;
	expiresAt: number;
}

export function validateResponse(
	data: unknown,
	schema: { type: string; properties?: Record<string, { type: string }>; required?: string[] },
): string[] {
	const warnings: string[] = [];

	const actualType = Array.isArray(data) ? "array" : typeof data;
	if (schema.type && actualType !== schema.type) {
		warnings.push(`Expected top-level type '${schema.type}', got '${actualType}'`);
		return warnings;
	}

	if (schema.required && typeof data === "object" && data !== null) {
		for (const key of schema.required) {
			if (!(key in (data as Record<string, unknown>))) {
				warnings.push(`Missing required key '${key}'`);
			}
		}
	}

	if (schema.properties && typeof data === "object" && data !== null) {
		const obj = data as Record<string, unknown>;
		for (const [key, prop] of Object.entries(schema.properties)) {
			if (key in obj) {
				const valType = Array.isArray(obj[key]) ? "array" : typeof obj[key];
				if (valType !== prop.type) {
					warnings.push(`Property '${key}' expected type '${prop.type}', got '${valType}'`);
				}
			}
		}
	}

	return warnings;
}

export class ApiExecutor {
	#cache = new Map<string, CacheEntry>();
	#lruOrder: string[] = [];

	clearCache(): void {
		this.#cache.clear();
		this.#lruOrder = [];
	}

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
	): Promise<{ ok: true; data: unknown; warnings?: string[] } | { ok: false; status: number; error: string }> {
		const pathParams: Record<string, string> = {};
		const queryParams: Record<string, string> = {};

		for (const param of op.parameters ?? []) {
			const value = resolvedParams[param.name];
			if (value === undefined) continue;
			if (param.in === "path") pathParams[param.name] = value;
			else if (param.in === "query") queryParams[param.name] = value;
		}

		const url = this.resolveUrl(auth.baseUrl, op.path, pathParams, queryParams);
		const cacheKey = `${JSON.stringify(auth.headers)}:${url}`;

		if (op.method === "GET") {
			const cached = this.#getCached(cacheKey);
			if (cached !== undefined) {
				logger.debug("ApiExecutor: cache hit", { url });
				return { ok: true, data: cached };
			}
		}

		if (WRITE_METHODS.has(op.method)) {
			// Use the resolved URL (path params already substituted) as the invalidation base.
			// For item-path writes (path ends in /{name}), strip the last segment so the
			// invalidation also covers cached list responses for the same collection.
			const prefix = /\/\{[^}]+\}$/.test(op.path) ? url.replace(/\/[^/?]+$/, "") : url.replace(/\?.*$/, "");
			this.#invalidateByPrefix(`${JSON.stringify(auth.headers)}:${prefix}`);
		}

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

		if (op.method === "GET") {
			this.#setCache(cacheKey, data);
		}

		if (op.responseSchema) {
			const warnings = validateResponse(data, op.responseSchema);
			return { ok: true, data, ...(warnings.length > 0 ? { warnings } : {}) };
		}

		return { ok: true, data };
	}

	#getCached(url: string): unknown | undefined {
		const entry = this.#cache.get(url);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.#cache.delete(url);
			this.#lruOrder = this.#lruOrder.filter(k => k !== url);
			return undefined;
		}
		this.#lruOrder = this.#lruOrder.filter(k => k !== url);
		this.#lruOrder.push(url);
		return entry.data;
	}

	#setCache(url: string, data: unknown): void {
		if (this.#cache.size >= CACHE_MAX_SIZE) {
			const oldest = this.#lruOrder.shift();
			if (oldest) this.#cache.delete(oldest);
		}
		this.#cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
		this.#lruOrder = this.#lruOrder.filter(k => k !== url);
		this.#lruOrder.push(url);
	}

	#invalidateByPrefix(prefix: string): void {
		for (const key of this.#cache.keys()) {
			if (key.startsWith(prefix)) {
				this.#cache.delete(key);
				this.#lruOrder = this.#lruOrder.filter(k => k !== key);
			}
		}
	}

	#requireEnv(name: string): string {
		const value = process.env[name];
		if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
		return value;
	}
}

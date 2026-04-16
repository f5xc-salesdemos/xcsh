import type { AgentTool, AgentToolResult } from "@f5xc-salesdemos/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ApiCatalogService } from "../services/api-catalog";
import type { ApiExecutor } from "../services/api-executor";
import type { ResolvedAuth } from "../services/api-types";

// ─── api_services ────────────────────────────────────────────────────────────

const servicesSchema = Type.Object({});

export class ApiServicesTool implements AgentTool<typeof servicesSchema> {
	readonly name = "api_services";
	readonly label = "List API Services";
	readonly description =
		"List all vendor API services available in the current session. Returns service names, operation counts, and category names.";
	readonly parameters = servicesSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(
		_toolCallId: string,
		_params: Static<typeof servicesSchema>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const services = await this.#catalog.getServices();

		if (services.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No API catalogs installed. Add an api-catalog.json to a marketplace plugin directory.",
					},
				],
			};
		}

		const lines = services.map(
			s => `- **${s.service}** (${s.displayName}) — ${s.operationCount} operations in: ${s.categories.join(", ")}`,
		);
		return { content: [{ type: "text", text: `Available API services:\n\n${lines.join("\n")}` }] };
	}
}

// ─── api_discover ─────────────────────────────────────────────────────────────

const discoverSchema = Type.Object({
	service: Type.String({ description: "Vendor service name (e.g., 'f5xc')" }),
	category: Type.Optional(Type.String({ description: "Narrow results to a specific category" })),
	search: Type.Optional(Type.String({ description: "Fuzzy match on operation name or description" })),
});

export class ApiDiscoverTool implements AgentTool<typeof discoverSchema> {
	readonly name = "api_discover";
	readonly label = "Discover API Operations";
	readonly description =
		"Browse available operations for an installed vendor API service. Returns operation names, HTTP methods, and danger levels. Optionally filter by category or search term.";
	readonly parameters = discoverSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(
		_toolCallId: string,
		{ service, category, search }: Static<typeof discoverSchema>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const services = await this.#catalog.getServices();
		if (!services.some(s => s.service === service)) {
			const names = services.map(s => s.service).join(", ") || "none";
			return { content: [{ type: "text", text: `Service '${service}' not found. Available: ${names}` }] };
		}

		const ops = search
			? await this.#catalog.search(service, search)
			: await this.#catalog.getOperations(service, category);

		if (ops.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No operations found for service '${service}'${category ? ` in category '${category}'` : ""}${search ? ` matching '${search}'` : ""}.`,
					},
				],
			};
		}

		const lines = ops.map(op => `- **${op.name}** [${op.method}] (${op.dangerLevel}) — ${op.description}`);
		const header = `Operations for ${service}${category ? ` / ${category}` : ""}:\n\n`;
		return { content: [{ type: "text", text: header + lines.join("\n") }] };
	}
}

// ─── api_describe ─────────────────────────────────────────────────────────────

const describeSchema = Type.Object({
	service: Type.String({ description: "Vendor service name" }),
	operation: Type.String({ description: "Operation name to describe" }),
});

export class ApiDescribeTool implements AgentTool<typeof describeSchema> {
	readonly name = "api_describe";
	readonly label = "Describe API Operation";
	readonly description =
		"Get full details for a single API operation: parameters, body schema, danger level, prerequisites, and common errors. Call before create/update/delete operations.";
	readonly parameters = describeSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(
		_toolCallId: string,
		{ service, operation }: Static<typeof describeSchema>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const op = await this.#catalog.getOperation(service, operation);
		if (!op) {
			return {
				content: [
					{
						type: "text",
						text: `Operation '${operation}' not found in service '${service}'. Use api_discover to browse available operations.`,
					},
				],
			};
		}

		const parts: string[] = [
			`**${op.name}**`,
			`Method: ${op.method}  Path: ${op.path}  Danger: ${op.dangerLevel}`,
			"",
			op.description,
		];

		if (op.parameters && op.parameters.length > 0) {
			parts.push("", "**Parameters:**");
			for (const p of op.parameters) {
				const req = p.required ? "required" : "optional";
				const def = p.default ? ` (default: ${p.default})` : "";
				parts.push(`- \`${p.name}\` [${p.in}] ${req} ${p.type}${def}${p.description ? ` — ${p.description}` : ""}`);
			}
		}

		if (op.prerequisites && op.prerequisites.length > 0) {
			parts.push("", "**Prerequisites:**");
			parts.push(...op.prerequisites.map(p => `- ${p}`));
		}

		if (op.commonErrors && op.commonErrors.length > 0) {
			parts.push("", "**Common Errors:**");
			parts.push(...op.commonErrors.map(e => `- HTTP ${e.code}: ${e.reason} → ${e.solution}`));
		}

		if (op.bestPractices && op.bestPractices.length > 0) {
			parts.push("", "**Best Practices:**");
			parts.push(...op.bestPractices.map(b => `- ${b}`));
		}

		return { content: [{ type: "text", text: parts.join("\n") }] };
	}
}

// ─── api_call ─────────────────────────────────────────────────────────────────

const callSchema = Type.Object({
	service: Type.String({ description: "Vendor service name (e.g., 'f5xc')" }),
	operation: Type.String({ description: "Operation name from catalog (e.g., 'list_http_loadbalancers')" }),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Path, query, or named parameters" }),
	),
	body: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Request body for POST/PUT/PATCH operations" }),
	),
});

const DANGER_NOTICE: Record<string, string> = {
	high: "High-danger operation. Proceeding.",
	critical: "Critical-danger operation — cannot execute automatically. Confirm with the user first.",
};

export class ApiCallTool implements AgentTool<typeof callSchema> {
	readonly name = "api_call";
	readonly label = "Call API";
	readonly description =
		"Execute a vendor API operation deterministically. Resolves auth from environment variables, substitutes path parameters, and returns the JSON response. For unfamiliar operations use api_discover first, for body shape use api_describe first.";
	readonly parameters = callSchema;

	#catalog: ApiCatalogService;
	#executor: ApiExecutor;

	constructor(catalog: ApiCatalogService, executor: ApiExecutor) {
		this.#catalog = catalog;
		this.#executor = executor;
	}

	async execute(
		_toolCallId: string,
		{ service, operation, params, body }: Static<typeof callSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const op = await this.#catalog.getOperation(service, operation);
		if (!op) {
			return {
				content: [
					{
						type: "text",
						text: `Operation '${operation}' not found in service '${service}'. Use api_discover to list available operations.`,
					},
				],
			};
		}

		if (op.dangerLevel === "critical") {
			return { content: [{ type: "text", text: DANGER_NOTICE.critical }] };
		}

		const catalog = await this.#catalog.getCatalog(service);
		if (!catalog) {
			return { content: [{ type: "text", text: `Catalog for service '${service}' could not be loaded.` }] };
		}

		let resolvedAuth: ResolvedAuth;
		try {
			resolvedAuth = this.#executor.resolveAuth(catalog.auth);
		} catch (err) {
			return {
				content: [
					{ type: "text", text: `Authentication error: ${err instanceof Error ? err.message : String(err)}` },
				],
			};
		}

		const userParams = params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : {};
		const resolvedParams = this.#executor.resolveParams(op, userParams);

		const missingRequired = (op.parameters ?? [])
			.filter(p => p.required && resolvedParams[p.name] === undefined)
			.map(p => `${p.name} (${p.in})`);
		if (missingRequired.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Missing required parameter(s): ${missingRequired.join(", ")}. Pass them via the \`params\` argument or set the corresponding environment variable.`,
					},
				],
			};
		}

		const result = await this.#executor.execute(
			resolvedAuth,
			op,
			resolvedParams,
			body as Record<string, unknown> | undefined,
			signal,
		);

		const prefix = op.dangerLevel === "high" ? `${DANGER_NOTICE.high}\n\n` : "";

		if (!result.ok) {
			return { content: [{ type: "text", text: `${prefix}Error: ${result.error}` }] };
		}

		const responseText = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
		return { content: [{ type: "text", text: `${prefix}${responseText}` }] };
	}
}

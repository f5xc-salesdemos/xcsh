export type ApiAuthType = "api_token" | "bearer" | "basic" | "custom";

export type ApiDangerLevel = "low" | "medium" | "high" | "critical";

export type ApiParamLocation = "path" | "query" | "body";

export interface ApiParameter {
	name: string;
	in: ApiParamLocation;
	required: boolean;
	type: string;
	description?: string;
	default?: string;
	example?: unknown;
}

export interface ApiOperation {
	name: string;
	description: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	dangerLevel: ApiDangerLevel;
	parameters?: ApiParameter[];
	bodySchema?: Record<string, unknown>;
	prerequisites?: string[];
	commonErrors?: Array<{ code: number; reason: string; solution: string }>;
	bestPractices?: string[];
	responseSchema?: {
		type: string;
		properties?: Record<string, { type: string }>;
		required?: string[];
	};
}

export interface ApiCategory {
	name: string;
	displayName: string;
	operations: ApiOperation[];
}

export interface ApiAuthConfig {
	type: ApiAuthType;
	headerName?: string;
	headerTemplate?: string;
	tokenSource?: string;
	usernameSource?: string;
	passwordSource?: string;
	headerValueSource?: string;
	baseUrlSource: string;
}

export interface ApiDefaults {
	[paramName: string]: { source: string };
}

export interface ApiCatalog {
	service: string;
	displayName: string;
	version: string;
	specSource?: string;
	auth: ApiAuthConfig;
	defaults?: ApiDefaults;
	categories: ApiCategory[];
}

export interface ApiCatalogMeta {
	service: string;
	displayName: string;
	version: string;
	filePath: string;
	operationCount: number;
	categories: string[];
}

export interface ResolvedAuth {
	headers: Record<string, string>;
	baseUrl: string;
}

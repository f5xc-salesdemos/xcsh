import { describe, expect, test } from "bun:test";
import { validateCatalog } from "./sync-catalog";

describe("validateCatalog", () => {
	test("accepts a valid catalog", () => {
		const catalog = {
			service: "f5xc",
			auth: { type: "api_token" },
			categories: [
				{
					name: "widgets",
					operations: [
						{ name: "list_widgets", method: "GET", path: "/widgets" },
					],
				},
			],
		};
		expect(() => validateCatalog(catalog)).not.toThrow();
	});

	test("rejects wrong service name", () => {
		const catalog = {
			service: "wrong",
			auth: { type: "api_token" },
			categories: [{ name: "x", operations: [{ name: "op1" }] }],
		};
		expect(() => validateCatalog(catalog)).toThrow("f5xc");
	});

	test("rejects zero operations", () => {
		const catalog = {
			service: "f5xc",
			auth: { type: "api_token" },
			categories: [],
		};
		expect(() => validateCatalog(catalog)).toThrow("0 operations");
	});

	test("rejects missing auth field", () => {
		const catalog = {
			service: "f5xc",
			categories: [{ name: "x", operations: [{ name: "op1" }] }],
		};
		expect(() => validateCatalog(catalog)).toThrow("auth");
	});
});

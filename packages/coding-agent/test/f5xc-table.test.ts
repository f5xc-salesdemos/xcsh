import { describe, expect, it } from "bun:test";
import { formatAuthIndicator, renderF5XCTable } from "../src/services/f5xc-table";

const vw = (s: string) => (s ? Bun.stringWidth(s) : 0);

describe("renderF5XCTable", () => {
	it("all lines have equal visible width", () => {
		const rows = [
			{ key: "F5XC_TENANT", value: "my-org" },
			{ key: "F5XC_API_URL", value: "https://my-org.console.ves.volterra.io" },
			{ key: "Status", value: "\x1b[38;5;34m\u25CF\x1b[0m Connected (42ms)" },
		];
		const output = renderF5XCTable("test-profile", rows);
		const lines = output.split("\n");
		const widths = lines.map(l => vw(l));
		expect(new Set(widths).size).toBe(1);
	});

	it("respects minimum inner width of 40", () => {
		const rows = [{ key: "A", value: "B" }];
		const output = renderF5XCTable("x", rows);
		const firstLine = output.split("\n")[0];
		// 40 inner chars + 2 border chars = 42 minimum visible width
		expect(vw(firstLine)).toBeGreaterThanOrEqual(42);
	});

	it("handles ANSI-colored values without misalignment", () => {
		const coloredValue = "\x1b[32m\u25CF Connected (100ms)\x1b[0m";
		const rows = [
			{ key: "Key", value: coloredValue },
			{ key: "Other", value: "plain text" },
		];
		const output = renderF5XCTable("title", rows);
		const lines = output.split("\n");
		const widths = lines.map(l => vw(l));
		expect(new Set(widths).size).toBe(1);
	});

	it("renders consistent widths with divider section", () => {
		const rows = [
			{ key: "F5XC_TENANT", value: "myorg" },
			{ key: "Status", value: formatAuthIndicator("connected", 55) },
			{ key: "F5XC_NAMESPACE", value: "default" },
			{ key: "F5XC_CUSTOM_VAR", value: "some-value" },
		];
		const output = renderF5XCTable("myorg", rows, { dividerBefore: 2 });
		const lines = output.split("\n");
		const widths = lines.map(l => vw(l));
		expect(new Set(widths).size).toBe(1);
	});

	it("handles long URLs without clipping the right border", () => {
		const rows = [
			{ key: "F5XC_API_URL", value: "https://very-long-tenant-name.console.ves.volterra.io/api" },
			{ key: "F5XC_NAMESPACE", value: "default" },
		];
		const output = renderF5XCTable("long-tenant", rows);
		const lines = output.split("\n");
		const widths = lines.map(l => vw(l));
		expect(new Set(widths).size).toBe(1);
	});
});

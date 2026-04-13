import type { AuthStatus } from "./f5xc-profile";

// F5 Brand Red — same as welcome.ts line 203
const F5_RED = "\x1b[38;5;160m";
const GREEN = "\x1b[38;5;34m";
const RED_TEXT = "\x1b[38;5;196m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// Box drawing chars — same as theme.ts lines 218-223
const BOX = {
	tl: "\u256D", // ╭
	tr: "\u256E", // ╮
	bl: "\u2570", // ╰
	br: "\u256F", // ╯
	h: "\u2500", // ─
	v: "\u2502", // │
	lt: "\u251C", // ├
	rt: "\u2524", // ┤
};

const r = (s: string) => `${F5_RED}${s}${RESET}`;

export function formatAuthIndicator(status: AuthStatus, latencyMs?: number): string {
	const ms = latencyMs !== undefined ? ` (${latencyMs}ms)` : "";
	switch (status) {
		case "connected":
			return `${GREEN}\u25CF${RESET} Connected${ms}`;
		case "auth_error":
			return `${RED_TEXT}\u25CB${RESET} Auth Error${ms}`;
		case "offline":
			return `${RED_TEXT}\u25CB${RESET} Offline`;
		default:
			return `\u25CB Unknown`;
	}
}

export interface TableRow {
	key: string;
	value: string;
}

export interface TableOptions {
	dividerBefore?: number; // insert ├──┤ divider before this row index
}

export function renderF5XCTable(title: string, rows: TableRow[], options?: TableOptions): string {
	// Calculate column widths from visible text (strip ANSI for width calc)
	const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const maxKey = Math.max(...rows.map(row => stripAnsi(row.key).length), 0);
	const maxVal = Math.max(...rows.map(row => stripAnsi(row.value).length), 0);
	const innerWidth = Math.max(maxKey + maxVal + 3, stripAnsi(title).length + 2, 40);

	const lines: string[] = [];

	// Top border: ╭─ title ──────╮
	const titleText = ` ${title} `;
	const titlePad = innerWidth - stripAnsi(titleText).length - 1;
	lines.push(`${r(BOX.tl + BOX.h)}${BOLD}${titleText}${RESET}${r(BOX.h.repeat(Math.max(0, titlePad)) + BOX.tr)}`);

	// Rows
	for (let i = 0; i < rows.length; i++) {
		// Optional divider
		if (options?.dividerBefore === i) {
			const divLabel = " Environment ";
			const divPad = innerWidth - stripAnsi(divLabel).length - 1;
			lines.push(`${r(BOX.lt + BOX.h)}${BOLD}${divLabel}${RESET}${r(BOX.h.repeat(Math.max(0, divPad)) + BOX.rt)}`);
		}

		const { key, value } = rows[i];
		const keyPad = maxKey - stripAnsi(key).length;
		const valPad = innerWidth - maxKey - stripAnsi(value).length - 3;
		lines.push(`${r(BOX.v)} ${key}${" ".repeat(keyPad)}  ${value}${" ".repeat(Math.max(0, valPad))} ${r(BOX.v)}`);
	}

	// Bottom border: ╰──────────────╯
	lines.push(r(BOX.bl + BOX.h.repeat(innerWidth) + BOX.br));

	return lines.join("\n");
}

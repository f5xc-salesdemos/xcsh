import { type Component, padding, truncateToWidth, visibleWidth } from "@f5xc-salesdemos/pi-tui";
import { APP_NAME } from "@f5xc-salesdemos/pi-utils";
import { theme } from "../../modes/theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

/**
 * Premium welcome screen with F5 XCSH logo and two-column layout.
 */
export class WelcomeComponent implements Component {
	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
	) {}

	invalidate(): void {}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 120;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 50;
		const minLeftCol = 48; // F5 logo width (46 chars + padding)
		const minRightCol = 20;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome back!"),
			visibleWidth(this.modelName),
			visibleWidth(this.providerName),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// F5 XCSH globe logo
		// biome-ignore format: preserve ASCII art layout
		const f5Logo = [
			"                   ________",
			"              (▒▒▒▒▓▓▓▓▓▓▓▓▒▒▒▒)",
			"         (▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒)",
			"      (▒▒▓▓▓▓██████████▓▓▓▓█████████████)",
			"    (▒▓▓▓▓██████▒▒▒▒▒███▓▓██████████████▒)",
			"   (▒▓▓▓▓██████▒▓▓▓▓▓▒▒▒▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒)",
			"  (▒▓▓▓▓▓██████▓▓▓▓▓▓▓▓▓██▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒)",
			" (▒▓▓███████████████▓▓▓▓█████████████▓▓▓▓▓▓▒)",
			"(▒▓▓▓▒▒▒███████▒▒▒▒▒▓▓▓████████████████▓▓▓▓▓▒)",
			"|▒▓▓▓▓▓▓▒██████▓▓▓▓▓▓▓████████████████████▓▓▒|",
			"|▒▓▓▓▓▓▓▓██████▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒██████████▓▒|",
			"(▒▓▓▓▓▓▓▓██████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒████████▒▒)",
			" (▒▓▓▓▓▓▓██████▓▓▓▓▓▓▓███▓▓▓▓▓▓▓▓▓▓▒▒▒████▒▒)",
			"  (▒▓▓▓▓▓██████▓▓▓▓▓▓█████▓▓▓▓▓▓▓▓▓▓▓▓███▒▒)",
			"   (▒▒██████████▓▓▓▓▓▒██████▓▓▓▓▓▓▓▓███▒▒▒)",
			"    (▒▒▒▒▒██████████▓▓▒▒█████████████▒▒▓▒)",
			"      (▒▓▓▒▒▒▒▒▒▒▒▒▒▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒)",
			"         (▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒)",
			"              (▒▒▒▒▓▓▓▓▓▓▓▓▒▒▒▒)",
		];

		// Apply F5 branding colors to logo
		const logoColored = f5Logo.map(line => this.#f5ColorLine(line));

		// Center the logo as a block (widest line = 46 chars), preserving internal alignment
		const logoMaxWidth = 46;
		const logoBlockPad = Math.max(0, Math.floor((leftCol - logoMaxWidth) / 2));
		const logoPadStr = padding(logoBlockPad);

		// Left column - logo only
		const leftLines = [...logoColored.map(l => logoPadStr + l), ""];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			for (const session of this.recentSessions.slice(0, 3)) {
				sessionLines.push(
					` ${theme.fg("dim", `${theme.md.bullet} `)}${theme.fg("muted", session.name)}${theme.fg("dim", ` (${session.timeAgo})`)}`,
				);
			}
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.success", "success")
						: server.status === "connecting"
							? theme.styledSymbol("status.pending", "muted")
							: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("contentAccent", "Tips"))}`,
			` ${theme.fg("dim", "?")}${theme.fg("muted", " for keyboard shortcuts")}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " to run python")}`,
			separator,
			` ${theme.bold(theme.fg("contentAccent", "LSP Servers"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("contentAccent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters (themed)
		const border = (s: string) => theme.fg("borderMuted", s);
		const hChar = theme.boxRound.horizontal;
		const h = border(hChar);
		const v = border(theme.boxRound.vertical);
		const tl = border(theme.boxRound.topLeft);
		const tr = border(theme.boxRound.topRight);
		const bl = border(theme.boxRound.bottomLeft);
		const br = border(theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = border(titlePrefixRaw) + theme.bold(theme.fg("text", title));
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + border(hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + border(theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		return lines;
	}

	/** Apply F5 branding colors: ▓→red solid, █→bold white, ▒→red, outlines→red */
	#f5ColorLine(line: string): string {
		const red = "\x1b[38;5;160m"; // F5 red (#ca260a)
		const white = "\x1b[1;37m"; // bold white
		const reset = "\x1b[0m";

		let result = "";
		for (const char of line) {
			if (char === "▓") {
				result += `${red}\u2588${reset}`; // render as solid block in red
			} else if (char === "█") {
				result += `${white}\u2588${reset}`; // solid block in bold white
			} else if (char === "▒") {
				result += `${red}\u2592${reset}`; // medium shade in red
			} else if ("()|_".includes(char)) {
				result += `${red}${char}${reset}`; // outlines in red
			} else {
				result += char;
			}
		}
		return result;
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}
}

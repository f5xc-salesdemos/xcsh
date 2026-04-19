import * as fs from "node:fs";
import type { AssistantMessage } from "@f5xc-salesdemos/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@f5xc-salesdemos/pi-tui";
import { formatCount, getShellPwd } from "@f5xc-salesdemos/pi-utils";
import { $ } from "bun";
import { settings } from "../../config/settings";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { calculatePromptTokens } from "../../session/compaction/compaction";
import type { EventBus } from "../../utils/event-bus";
import * as git from "../../utils/git";
import { queryGitStatus } from "../../utils/gitstatus";
import { sanitizeStatusText } from "../shared";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	type PrCacheContext,
} from "./status-line/git-utils";
import { getPreset } from "./status-line/presets";
import { renderSegment, type SegmentContext } from "./status-line/segments";
import { getSeparator } from "./status-line/separators";
import { calculateTokensPerSecond } from "./status-line/token-rate";

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
	context_pct?: { compact?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering Helpers
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#cwdUnsubscribe: (() => void) | null = null;
	#onBranchChange: (() => void) | null = null;
	#onStatusChanged: (() => void) | null = null;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	#sessionStartTime: number = Date.now();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#cwd: string = getShellPwd();

	// Git status caching (1s TTL)
	#cachedGitStatus: {
		staged: number;
		unstaged: number;
		untracked: number;
		conflicted: number;
		ahead: number;
		behind: number;
		stashes: number;
		action: string;
	} | null = null;
	#gitStatusLastFetch = 0;
	#gitStatusInFlight = false;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	constructor(private readonly session: AgentSession) {
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
		};
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	setSessionStartTime(time: number): void {
		this.#sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	onStatusChanged(callback: () => void): void {
		this.#onStatusChanged = callback;
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	watchCwd(eventBus: EventBus): void {
		this.#cwdUnsubscribe?.();
		this.#cwdUnsubscribe = eventBus.on("cwd:changed", newCwd => {
			if (typeof newCwd === "string") this.#cwd = newCwd;
			this.#invalidateGitCaches();
			this.#setupGitWatcher();
			this.#onStatusChanged?.();
		});
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		const gitHeadPath = git.repo.resolveSync(this.#cwd)?.headPath ?? null;
		if (!gitHeadPath) return;

		try {
			this.#gitWatcher = fs.watch(gitHeadPath, () => {
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
		if (this.#cwdUnsubscribe) {
			this.#cwdUnsubscribe();
			this.#cwdUnsubscribe = null;
		}
	}

	invalidate(): void {
		this.#invalidateGitCaches();
	}

	/** Update the displayed working directory (e.g. after a user !cd command). */
	setCwd(cwd: string): void {
		this.#cwd = cwd;
		this.#invalidateGitCaches();
		this.#setupGitWatcher();
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(): string | null {
		const head = git.head.resolveSync(this.#cwd);
		const gitHeadPath = head?.headPath ?? null;
		if (this.#cachedBranch !== undefined && this.#cachedBranchRepoId === gitHeadPath) {
			return this.#cachedBranch;
		}

		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {
			this.#cachedBranch = null;
			return null;
		}

		this.#cachedBranch = head.kind === "ref" ? (head.branchName ?? head.ref) : "detached";

		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string): boolean {
		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			(async () => {
				const resolved = await git.branch.default(this.#cwd);
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(): {
		staged: number;
		unstaged: number;
		untracked: number;
		conflicted: number;
		ahead: number;
		behind: number;
		stashes: number;
		action: string;
	} | null {
		if (this.#gitStatusInFlight || Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlight = true;

		(async () => {
			try {
				// Prefer gitstatusd daemon (10x faster than git CLI)
				const gsResult = await queryGitStatus(this.#cwd);
				if (gsResult) {
					this.#cachedGitStatus = {
						staged: gsResult.staged,
						unstaged: gsResult.unstaged,
						untracked: gsResult.untracked,
						conflicted: gsResult.conflicted,
						ahead: gsResult.ahead,
						behind: gsResult.behind,
						stashes: gsResult.stashes,
						action: gsResult.action,
					};
				} else {
					// Fallback to git CLI
					const summary = await git.status.summary(this.#cwd);
					this.#cachedGitStatus = summary
						? { ...summary, conflicted: 0, ahead: 0, behind: 0, stashes: 0, action: "" }
						: null;
				}
			} catch {
				this.#cachedGitStatus = null;
			} finally {
				this.#gitStatusLastFetch = Date.now();
				this.#gitStatusInFlight = false;
				this.#onStatusChanged?.();
			}
		})();

		return this.#cachedGitStatus;
	}

	#lookupPr(): { number: number; url: string } | null {
		const branch = this.#getCurrentBranch();
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		// Don't look up if no branch, detached HEAD, default branch, or already in flight
		if (!branch || branch === "detached" || this.#isDefaultBranch(branch) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch();
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Requires `gh repo set-default` to be configured; fails gracefully if not
				const result = await $`gh pr view --json number,url`.cwd(this.#cwd).quiet().nothrow();
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout.toString()) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	#buildSegmentContext(width: number): SegmentContext {
		const state = this.session.state;

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		// Get context percentage
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find(m => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage ? calculatePromptTokens(lastAssistantMessage.usage) : 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		return {
			session: this.session,
			width,
			cwd: this.#cwd,
			options: this.#resolveSettings().segmentOptions ?? {},
			planMode: this.#planModeStatus,
			usageStats,
			contextPercent,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			sessionStartTime: this.#sessionStartTime,
			git: {
				branch: this.#getCurrentBranch(),
				status: this.#getGitStatus(),
				pr: this.#lookupPr(),
			},
		};
	}

	#resolveSettings(): Required<
		Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
	> &
		StatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#buildStatusLine(width: number): string {
		const ctx = this.#buildSegmentContext(width);
		const effectiveSettings = this.#resolveSettings();
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		const defaultBg = theme.getBgAnsi("statusLineBg");
		const defaultFg = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		// Collect visible segments (preserving bg/fg metadata)
		type SegPart = { content: string; bg: string; fg: string };
		const collectParts = (segIds: readonly string[]): SegPart[] => {
			const parts: SegPart[] = [];
			for (const segId of segIds) {
				const rendered = renderSegment(segId as any, ctx);
				if (rendered.visible && rendered.content) {
					parts.push({
						content: rendered.content,
						bg: rendered.bg || defaultBg,
						fg: rendered.fg || defaultFg,
					});
				}
			}
			return parts;
		};

		const leftParts = collectParts(effectiveSettings.leftSegments);
		const rightParts = collectParts(effectiveSettings.rightSegments);

		const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
		if (runningBackgroundJobs > 0) {
			const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
			const label = `${formatCount("job", runningBackgroundJobs)} running`;
			rightParts.push({
				content: theme.fg("statusLineSubagents", `${icon}${label}`),
				bg: defaultBg,
				fg: defaultFg,
			});
		}

		const topFillWidth = Math.max(0, width);
		const left = [...leftParts];
		const right = [...rightParts];

		const sepWidth = visibleWidth(separatorDef.left);
		const capWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.right) : 0;

		const groupWidth = (parts: SegPart[]): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, p) => sum + visibleWidth(p.content), 0);
			// Each segment gets 1 char padding on each side, separators between segments
			const sepTotal = Math.max(0, parts.length - 1) * sepWidth;
			return partsWidth + parts.length * 2 + sepTotal + capWidth;
		};

		let leftWidth = groupWidth(left);
		let rightWidth = groupWidth(right);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right);
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftWidth = groupWidth(left);
			}
		}

		// Render a group of segments with per-segment backgrounds and separators
		const renderGroup = (parts: SegPart[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";

			const hasPowerline = separatorDef.endCaps?.useBgAsFg;
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;

			// Check if any segment has a custom bg (different from default)
			const hasCustomBg = parts.some(p => p.bg !== defaultBg);

			// Fast path: no custom bgs, use original flat rendering
			if (!hasCustomBg) {
				const cap = separatorDef.endCaps
					? direction === "left"
						? separatorDef.endCaps.right
						: separatorDef.endCaps.left
					: "";
				const capPrefix = hasPowerline ? defaultBg.replace("\x1b[48;", "\x1b[38;") : defaultBg + sepAnsi;
				const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

				let content = defaultBg + defaultFg;
				content += ` ${parts.map(p => p.content).join(` ${sepAnsi}${sep}${defaultFg} `)} `;
				content += "\x1b[0m";

				if (capText) {
					return direction === "right" ? capText + content : content + capText;
				}
				return content;
			}

			// Per-segment colored rendering
			let output = "";

			// Leading cap for right groups (left-pointing arrow before first segment)
			if (direction === "right" && hasPowerline && separatorDef.endCaps) {
				const firstBg = parts[0].bg;
				const capFg = firstBg.replace("\x1b[48;", "\x1b[38;");
				output += `\x1b[0m${capFg}${separatorDef.endCaps.left}`;
			}

			for (let i = 0; i < parts.length; i++) {
				const seg = parts[i];
				const nextBg = i < parts.length - 1 ? parts[i + 1].bg : null;

				// Segment content with its own bg and fg
				output += `${seg.bg}${seg.fg} ${seg.content} `;

				if (nextBg !== null) {
					if (hasPowerline) {
						// Powerline transition: fg = this segment's bg, bg = next segment's bg
						const transFg = seg.bg.replace("\x1b[48;", "\x1b[38;");
						output += `\x1b[0m${transFg}${nextBg}${sep}`;
					} else {
						// Non-powerline: separator between colored segments
						output += `\x1b[0m${sepAnsi}${sep}\x1b[0m`;
					}
				}
			}
			// End cap / trailing edge
			if (hasPowerline && direction === "left") {
				// Right-pointing arrow after last left segment
				const lastBg = parts[parts.length - 1].bg;
				const endFg = lastBg.replace("\x1b[48;", "\x1b[38;");
				output += `\x1b[0m${endFg}${separatorDef.left}\x1b[0m`;
			} else {
				output += "\x1b[0m";
			}

			return output;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		leftWidth = groupWidth(left);
		rightWidth = groupWidth(right);
		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const gapFill = theme.fg("border", theme.boxRound.horizontal.repeat(gapWidth));
		return leftGroup + gapFill + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		const content = this.#buildStatusLine(width);
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}

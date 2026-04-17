/**
 * Web search CLI command handlers.
 *
 * Handles `xcsh q`/`xcsh web-search` subcommands for testing web search providers.
 */

import { buildAnthropicSearchHeaders, buildAnthropicUrl, findAnthropicAuth } from "@f5xc-salesdemos/pi-ai";
import { $env, APP_NAME } from "@f5xc-salesdemos/pi-utils";
import chalk from "chalk";
import { initTheme, theme } from "../modes/theme/theme";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";
import { renderSearchResult } from "../web/search/render";
import type { SearchProviderId, SearchResponse } from "../web/search/types";

export interface SearchCommandArgs {
	query: string;
	provider?: SearchProviderId | "auto";
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
	synthesize: boolean;
	synthesizeModel?: string;
}

const PROVIDERS: Array<SearchProviderId | "auto"> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

/**
 * Parse web search subcommand arguments.
 * Returns undefined if not a web search command.
 */
export function parseSearchArgs(args: string[]): SearchCommandArgs | undefined {
	if (args.length === 0 || (args[0] !== "q" && args[0] !== "web-search")) {
		return undefined;
	}

	const result: SearchCommandArgs = {
		query: "",
		expanded: true,
		synthesize: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--provider") {
			result.provider = args[++i] as SearchCommandArgs["provider"];
		} else if (arg === "--recency") {
			result.recency = args[++i] as SearchCommandArgs["recency"];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = Number.parseInt(args[++i], 10);
		} else if (arg === "--compact") {
			result.expanded = false;
		} else if (arg === "--no-synthesize") {
			result.synthesize = false;
		} else if (arg === "--model") {
			result.synthesizeModel = args[++i];
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length > 0) {
		result.query = positional.join(" ");
	}

	return result;
}

async function synthesizeResponse(
	query: string,
	searchResponse: SearchResponse,
	model?: string,
): Promise<string | undefined> {
	const auth = await findAnthropicAuth();
	if (!auth) return undefined;

	const sourcesContext = searchResponse.sources
		.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.url}${s.snippet ? `\n    ${s.snippet}` : ""}`)
		.join("\n");

	const citationsContext =
		searchResponse.citations?.map((c, i) => `[${i + 1}] ${c.title}: "${c.citedText}"`).join("\n") ?? "";

	const synthesisPrompt = `Based on the following web search results for the query "${query}", provide a comprehensive, well-structured answer. Cite sources by number.

## Search Results
${searchResponse.answer ? `### Initial Answer\n${searchResponse.answer}\n` : ""}
### Sources
${sourcesContext}
${citationsContext ? `\n### Citations\n${citationsContext}` : ""}

Provide a thorough answer with key facts, numbers, and source citations.`;

	const url = buildAnthropicUrl(auth);
	const headers = buildAnthropicSearchHeaders(auth);
	const selectedModel = model ?? $env.ANTHROPIC_SEARCH_MODEL ?? "claude-haiku-4-5";

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: selectedModel,
			max_tokens: 4096,
			messages: [{ role: "user", content: synthesisPrompt }],
		}),
	});

	if (!response.ok) return undefined;

	const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
	return data.content
		?.filter(b => b.type === "text" && b.text)
		.map(b => b.text)
		.join("\n\n");
}

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red("Error: Query is required")}\n`);
		process.exit(1);
	}

	if (cmd.provider && !PROVIDERS.includes(cmd.provider)) {
		process.stderr.write(`${chalk.red(`Error: Unknown provider "${cmd.provider}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid providers: ${PROVIDERS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`Error: Invalid recency "${cmd.recency}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid recency values: ${RECENCY_OPTIONS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red("Error: --limit must be a number")}\n`);
		process.exit(1);
	}

	await initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		provider: cmd.provider,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		allowLongAnswer: true,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (cmd.synthesize && result.details?.response && result.details.response.sources.length > 0) {
		try {
			process.stderr.write(chalk.dim("\nSynthesizing response...\n"));
			const synthesized = await synthesizeResponse(cmd.query, result.details.response, cmd.synthesizeModel);
			if (synthesized) {
				process.stdout.write(`\n${chalk.bold("Synthesized Answer:")}\n\n${synthesized}\n`);
			}
		} catch {
			process.stderr.write(chalk.dim("Synthesis unavailable — showing raw search results only.\n"));
		}
	}

	if (result.details?.error) {
		process.exitCode = 1;
	}
}

export function printSearchHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} q`)} - Test web search providers

${chalk.bold("Usage:")}
  ${APP_NAME} q [options] <query>
  ${APP_NAME} web-search [options] <query>

${chalk.bold("Arguments:")}
  query      Search query text

${chalk.bold("Options:")}
  --provider <name>   Provider: ${PROVIDERS.join(", ")}
  --recency <value>   Recency filter (Brave/Perplexity): ${RECENCY_OPTIONS.join(", ")}
  -l, --limit <n>     Max results to return
  --compact           Render condensed output
  --no-synthesize     Skip synthesis step (raw search only)
  --model <name>      Model for synthesis (default: ANTHROPIC_SEARCH_MODEL or claude-haiku-4-5)
  -h, --help          Show this help

${chalk.bold("Examples:")}
  ${APP_NAME} q --provider=exa "what's the color of the sky"
  ${APP_NAME} q --provider=brave --recency=week "latest TypeScript 5.7 changes"
`);
}

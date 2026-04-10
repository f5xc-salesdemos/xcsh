/**
 * High-performance git status via gitstatusd daemon.
 *
 * gitstatusd is a C binary that provides git status 10x faster than
 * `git status --porcelain` by caching dirty file state in memory.
 * Protocol: named pipes with \x1f field separators and \x1e record terminators.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@f5xc-salesdemos/pi-utils";

export interface GitStatusResult {
	workdir: string;
	commit: string;
	localBranch: string;
	remoteBranch: string;
	remoteName: string;
	remoteUrl: string;
	action: string;
	indexSize: number;
	staged: number;
	unstaged: number;
	conflicted: number;
	untracked: number;
	ahead: number;
	behind: number;
	stashes: number;
	tag: string;
	commitSummary: string;
}

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

let daemon: { proc: ReturnType<typeof Bun.spawn>; requestId: number } | null = null;
let startAttempted = false;

function findGitstatusd(): string | null {
	const cacheDir = path.join(os.homedir(), ".cache", "gitstatus");
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	const binary = path.join(cacheDir, `gitstatusd-${platform}-${arch}`);
	if (fs.existsSync(binary)) return binary;

	// Fallback: search PATH
	const result = Bun.spawnSync(["which", "gitstatusd"], { stdout: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();

	return null;
}

function startDaemon(): boolean {
	if (daemon) return true;
	if (startAttempted) return false;
	startAttempted = true;

	const binary = findGitstatusd();
	if (!binary) {
		logger.debug("gitstatusd not found, falling back to git CLI");
		return false;
	}

	try {
		const proc = Bun.spawn(
			[binary, "-G", "v1.5.4", "-s", "-1", "-u", "-1", "-d", "-1", "-c", "-1", "-m", "-1", "-v", "FATAL", "-t", "4"],
			{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);

		daemon = { proc, requestId: 0 };

		proc.exited.then(() => {
			daemon = null;
		});

		return true;
	} catch (err) {
		logger.debug("Failed to start gitstatusd", { error: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

export async function queryGitStatus(directory: string, timeoutMs = 3000): Promise<GitStatusResult | null> {
	if (!startDaemon()) return null;
	if (!daemon) return null;

	const reqId = String(++daemon.requestId);
	const request = `${reqId}${FIELD_SEP}${directory}${RECORD_SEP}`;

	try {
		const stdin = daemon.proc.stdin as { write(data: string): void; flush(): void };
		stdin.write(request);
		stdin.flush();

		const reader = (daemon.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs));
		const readPromise = reader.read().then(({ value }) => (value ? new TextDecoder().decode(value) : null));

		const response = await Promise.race([readPromise, timeoutPromise]);
		reader.releaseLock();

		if (!response) return null;

		const raw = response.replace(RECORD_SEP, "");
		const fields = raw.split(FIELD_SEP);

		if (fields.length < 20 || fields[0] !== reqId || fields[1] !== "1") {
			return null;
		}

		return {
			workdir: fields[2] || "",
			commit: fields[3] || "",
			localBranch: fields[4] || "",
			remoteBranch: fields[5] || "",
			remoteName: fields[6] || "",
			remoteUrl: fields[7] || "",
			action: fields[8] || "",
			indexSize: parseInt(fields[9] || "0", 10),
			staged: parseInt(fields[10] || "0", 10),
			unstaged: parseInt(fields[11] || "0", 10),
			conflicted: parseInt(fields[12] || "0", 10),
			untracked: parseInt(fields[13] || "0", 10),
			ahead: parseInt(fields[14] || "0", 10),
			behind: parseInt(fields[15] || "0", 10),
			stashes: parseInt(fields[16] || "0", 10),
			tag: fields[17] || "",
			commitSummary: fields[27] || "",
		};
	} catch {
		return null;
	}
}

export function stopDaemon(): void {
	if (daemon) {
		daemon.proc.kill();
		daemon = null;
	}
}

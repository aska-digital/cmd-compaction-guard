// Detection and repair for compaction-summary bloat in Command Code
// session transcripts (.jsonl).
//
// The harness projects stored compaction entries back into the
// summarizer's input at full length (entryToContextMessages ->
// projectEntryForSummary -> prepareBranchEntries, with
// BOUNDARY_SQUEEZE_FRACTION letting summaries squeeze past the token
// budget) and caps neither the digest nor the projected summaries. Each
// compaction's `summary` therefore embeds the previous ones, and the
// stack compounds with every compaction: session 3e33503f grew
// 3KB -> 48KB -> 88KB -> 217KB -> 345KB -> 582KB -> 1.1MB across seven
// compactions until the context meter read 648.8K/256K and every
// request 400'd.

export interface CompactionEntry {
	line: number; // 1-based line in the transcript
	id: string;
	summaryChars: number;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	timestamp?: string;
	fromMod?: boolean;
}

export interface TranscriptAnalysis {
	compactions: CompactionEntry[];
	totalSummaryChars: number;
	largestSummaryChars: number;
	duplicateFirstKeptIds: string[];
	growthRatio: number;
	bloated: boolean;
}

// Stacked summaries above this size are context the user never asked to
// keep: 100KB is ~25k tokens of pure compaction residue.
export const BLOAT_THRESHOLD_CHARS = 100_000;

export function analyzeTranscript(text: string): TranscriptAnalysis {
	const compactions: CompactionEntry[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "compaction") continue;
		compactions.push({
			line: index + 1,
			id: String(entry.id ?? ""),
			summaryChars: typeof entry.summary === "string" ? entry.summary.length : 0,
			firstKeptEntryId:
				typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
			tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
			fromMod: entry.fromMod === true,
		});
	}

	const totalSummaryChars = compactions.reduce((sum, c) => sum + c.summaryChars, 0);
	const largestSummaryChars = compactions.reduce((max, c) => Math.max(max, c.summaryChars), 0);
	const counts = new Map<string, number>();
	for (const c of compactions) {
		if (!c.firstKeptEntryId) continue;
		counts.set(c.firstKeptEntryId, (counts.get(c.firstKeptEntryId) ?? 0) + 1);
	}
	const duplicateFirstKeptIds = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => id);
	const firstSummary = compactions[0]?.summaryChars ?? 0;
	const growthRatio = firstSummary > 0 ? largestSummaryChars / firstSummary : 0;

	return {
		compactions,
		totalSummaryChars,
		largestSummaryChars,
		duplicateFirstKeptIds,
		growthRatio,
		bloated: totalSummaryChars > BLOAT_THRESHOLD_CHARS,
	};
}

export interface RepairResult {
	repaired: boolean;
	reason?: string;
	text: string;
	originalChars: number;
	repairedChars: number;
	summaryCharsBefore: number;
	summaryCharsAfter: number;
	compactionsBlanked: number;
}

const KEEP_HEAD_CHARS = 2000;
const KEEP_TAIL_CHARS = 4000;
const TRUNCATION_MARKER =
	"\n\n... [summary truncated by compaction-guard; full text preserved in the .bak backup] ...\n\n";

// Repair: blank every stacked summary except the newest, and keep the
// newest as head + tail. The entry chain (id / parentId /
// firstKeptEntryId) is preserved verbatim, so the session still loads
// and resumes; only the summary text shrinks.
export function repairTranscript(text: string): RepairResult {
	const analysis = analyzeTranscript(text);
	const originalChars = text.length;
	const summaryCharsBefore = analysis.totalSummaryChars;
	const base = {
		text,
		originalChars,
		repairedChars: originalChars,
		summaryCharsBefore,
		summaryCharsAfter: summaryCharsBefore,
		compactionsBlanked: 0,
	};
	if (analysis.compactions.length === 0) {
		return {...base, repaired: false, reason: "no compaction entries in the transcript"};
	}
	if (!analysis.bloated) {
		return {
			...base,
			repaired: false,
			reason: `stacked summaries total ${summaryCharsBefore} chars, under the ${BLOAT_THRESHOLD_CHARS}-char bloat threshold`,
		};
	}

	const lines = text.split("\n");
	const lastLine = analysis.compactions[analysis.compactions.length - 1].line;
	let compactionsBlanked = 0;
	let summaryCharsAfter = 0;
	for (const compaction of analysis.compactions) {
		const lineIndex = compaction.line - 1;
		const entry = JSON.parse(lines[lineIndex]) as Record<string, unknown>;
		if (compaction.line === lastLine) {
			const summary = entry.summary as string;
			if (summary.length > KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) {
				entry.summary =
					summary.slice(0, KEEP_HEAD_CHARS) + TRUNCATION_MARKER + summary.slice(-KEEP_TAIL_CHARS);
			}
		} else {
			entry.summary = "";
			compactionsBlanked += 1;
		}
		summaryCharsAfter += typeof entry.summary === "string" ? (entry.summary as string).length : 0;
		lines[lineIndex] = JSON.stringify(entry);
	}
	const repairedText = lines.join("\n");
	return {
		repaired: true,
		text: repairedText,
		originalChars,
		repairedChars: repairedText.length,
		summaryCharsBefore,
		summaryCharsAfter,
		compactionsBlanked,
	};
}

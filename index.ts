import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {analyzeTranscript, repairTranscript} from './detect';

// Compaction guard: detects compaction-summary bloat in the session
// transcript and repairs it on demand.
//
// The harness's compaction projects stored compaction entries back into
// the summarizer at full length and does not cap the digest, so each
// compaction's summary embeds the previous ones. The stack compounds
// with every compaction until the context exceeds the model window and
// every request 400s. The guard reads the transcript after each
// compaction, warns while the session is still recoverable, and
// /compact-repair truncates the stack (entry chain preserved, .bak kept).

interface CompactionRecord {
	at: string;
	tokensSaved?: number;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('compaction-guard', {
		type: 'boolean',
		default: true,
		description:
			'Warn when compaction summaries bloat the transcript; adds /compact-report and /compact-repair.',
	});

	const compactions: CompactionRecord[] = [];
	let sessionId = '';

	cmd.on('run_start', ({sessionId: id}: {sessionId?: string}) => {
		if (id) sessionId = id;
	});

	cmd.on('compaction_done', ({tokensSaved}: {tokensSaved?: number}) => {
		if (cmd.getFlag('compaction-guard') === false) return;
		compactions.push({at: new Date().toISOString(), tokensSaved});
		checkTranscript(cmd);
	});

	// compaction appends are enqueued, so the transcript on disk can lag
	// the compaction_done event; re-check at the end of the turn, by
	// which time any in-flight write has landed.
	cmd.on('turn_end', () => {
		if (cmd.getFlag('compaction-guard') === false) return;
		if (compactions.length === 0) return;
		checkTranscript(cmd);
	});

	cmd.addCommand({
		name: 'compact-report',
		handler: () => {
			const sessionPath = resolveSessionPath();
			if (!sessionPath) {
				return {message: 'compaction-guard: session transcript not found for this session yet.'};
			}
			const analysis = analyzeTranscript(fs.readFileSync(sessionPath, 'utf8'));
			const lines = analysis.compactions.map(
				(c) =>
					`  line ${c.line}: summary ${fmtKB(c.summaryChars)}` +
					(c.tokensBefore ? `, tokensBefore ${c.tokensBefore}` : '') +
					(c.fromMod ? ', mod-triggered' : ''),
			);
			const duplicates = analysis.duplicateFirstKeptIds.length
				? `\n  redundant nested compactions (shared firstKeptEntryId): ${analysis.duplicateFirstKeptIds.join(', ')}`
				: '';
			return {
				message:
					`compaction-guard: ${analysis.compactions.length} compaction(s) in ${sessionPath}\n` +
					lines.join('\n') +
					`\n  stacked summaries: ${fmtMB(analysis.totalSummaryChars)} (largest ${fmtKB(analysis.largestSummaryChars)}, growth ${analysis.growthRatio.toFixed(1)}x)${duplicates}\n` +
					(analysis.bloated ? '  STATUS: bloated - run /compact-repair' : '  STATUS: healthy'),
			};
		},
	});

	cmd.addCommand({
		name: 'compact-repair',
		handler: () => {
			const sessionPath = resolveSessionPath();
			if (!sessionPath) {
				return {message: 'compaction-guard: session transcript not found for this session yet.'};
			}
			const result = repairTranscript(fs.readFileSync(sessionPath, 'utf8'));
			if (!result.repaired) {
				return {message: `compaction-guard: no repair needed (${result.reason}).`};
			}
			const backup = `${sessionPath}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
			fs.copyFileSync(sessionPath, backup);
			const tmpPath = `${sessionPath}.tmp`;
			fs.writeFileSync(tmpPath, result.text);
			fs.renameSync(tmpPath, sessionPath);
			return {
				message:
					`compaction-guard: repaired ${sessionPath}\n` +
					`  stacked summaries: ${fmtMB(result.summaryCharsBefore)} -> ${fmtKB(result.summaryCharsAfter)} (${result.compactionsBlanked} compactions blanked, newest kept as head+tail)\n` +
					`  transcript: ${fmtMB(result.originalChars)} -> ${fmtMB(result.repairedChars)}\n` +
					`  backup: ${backup}\n` +
					'Reopen the session (or restart the app) so the harness reloads the transcript.',
			};
		},
	});

	function checkTranscript(cmd: ModApi): void {
		const sessionPath = resolveSessionPath();
		if (!sessionPath) return;
		const analysis = analyzeTranscript(fs.readFileSync(sessionPath, 'utf8'));
		if (!analysis.bloated) return;
		cmd.ui.notify(
			`compaction-guard: the transcript carries ${fmtMB(analysis.totalSummaryChars)} of stacked compaction summaries across ${analysis.compactions.length} compactions (largest ${fmtKB(analysis.largestSummaryChars)}). The stack counts as context and compounds with every compaction. Run /compact-repair to truncate it (a .bak backup is kept).`,
		);
	}

	function resolveSessionPath(): string | null {
		if (!sessionId) return null;
		// The harness stores transcripts under
		// ~/.commandcode/projects/<encoded-cwd>/<sessionId>.jsonl, where
		// <encoded-cwd> is the workspace path without the leading slash and
		// with "/" replaced by "-".
		const encoded = process.cwd().replace(/^\//, '').replace(/\//g, '-');
		const candidate = path.join(os.homedir(), '.commandcode', 'projects', encoded, `${sessionId}.jsonl`);
		return fs.existsSync(candidate) ? candidate : null;
	}
}

function fmtKB(chars: number): string {
	return `${(chars / 1000).toFixed(0)}KB`;
}

function fmtMB(chars: number): string {
	return `${(chars / 1e6).toFixed(2)}MB`;
}

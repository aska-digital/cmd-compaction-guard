# cmd-compaction-guard

A Command Code mod that detects compaction-summary bloat in session transcripts and repairs it on demand.

The harness's compaction projects stored compaction entries back into the summarizer's input at full length and does not cap the digest, so each compaction's summary embeds the previous ones. The stack compounds with every compaction. Observed growth in one session: 3KB → 48KB → 88KB → 217KB → 345KB → 582KB → 1.1MB across seven compactions, until the context meter read 648.8K/256K and every request was rejected with a 400. Compaction "saves" almost nothing at that point (the last run reported ~5.3k tokens saved) because almost everything is already summary text.

The guard reads the transcript after each compaction and warns while the session is still recoverable. `/compact-repair` truncates the stack: older summaries are blanked, the newest is kept as head + tail, and the entry chain (id / parentId / firstKeptEntryId) is preserved so the session still loads and resumes. A `.bak` backup is always written first.

## Install

```bash
cmd mods add ahrazzle/cmd-compaction-guard
```

Or drop the files in `~/.commandcode/mods/`.

## What you get

- A feed notice after a compaction (and at the following turn end) when stacked summaries pass the bloat threshold (100KB), with the stack size and the repair hint.
- `/compact-report`: per-compaction breakdown of the current session. Summary sizes, tokensBefore, growth ratio, and redundant nested compactions (entries sharing a `firstKeptEntryId`).
- `/compact-repair`: rewrites the transcript with the stack truncated, keeps a timestamped `.bak`, and reports before/after sizes. Reopen the session afterwards so the harness reloads the transcript.

`--mod-option compaction-guard=false` turns the checks off.

> Automated posting by agentic team with human oversight.

---
summary: The archive format, the import planner and executor, the provider contract, and the IPC calls that move sessions between machines.
read_when:
  - Adding a provider or changing what a provider exports or writes
  - Changing the archive format or its limits
  - Building UI on top of the session IPC calls
  - Debugging an import that failed, rolled back, or was refused
  - Changing what the Conversation preview reads or shows
  - Changing how sessions are listed, cached, or refreshed
---

# Moving sessions between machines

[Session storage and transfer rules](session-storage.md) says what each agent stores and what import must do. This doc says how the code does it. The code is in `src/main/core/`, `src/main/archive/`, and `src/main/providers/`.

## Archive format

An archive is one `*.agentsessions` file, a gzip-compressed ustar tar. The first entry is `manifest.json`. Every other entry is `blobs/<sha256>`, one per distinct file content, so two sessions that share a file store it once.

The manifest (`src/main/core/manifest.ts`) is version 1:

```json
{
  "format": "agent-sessions-archive",
  "version": 1,
  "createdAt": "2026-11-07T10:00:00.000Z",
  "appVersion": "0.0.0",
  "source": { "platform": "darwin", "homeDir": "/Users/alice", "sep": "/", "storeRoots": { "claude-code": "/Users/alice/.claude" } },
  "sessions": [
    {
      "agent": "claude-code", "id": "<uuid>", "title": "…", "client": "cli", "clientDetail": "cli",
      "cwd": "/Users/alice/proj", "cwds": ["/Users/alice/proj"],
      "createdAt": "…", "lastActivity": "…", "cliVersion": "2.1.319", "gitBranch": "main",
      "files": [{ "role": "transcript", "path": "projects/-Users-alice-proj/<uuid>.jsonl", "sha256": "…", "size": 1234, "mtimeMs": 0 }]
    }
  ]
}
```

`gitBranch` is the branch the session was on at its last record that names one, so the user knows what to check out before resuming. It is null outside a repo, and an archive written before the field existed reads as null. The reader accepts a non-empty string up to the 4096-character cap every text field has.

`files[].path` is relative to the source store and always uses `/`. `ROLES_BY_AGENT` lists the roles each agent may use: `transcript`, `subagent`, and `tool-result` for Claude Code, and `rollout`, `subagent-rollout`, `linked-rollout`, `generated-image`, and `index-entry` for Codex. A Codex `subagent-rollout` is the newest rollout of a subagent thread that the session's thread spawned, at any depth. The original brief did not include `source.storeRoots`. Import needs it to rewrite `toolUseResult.persistedOutputPath`, which names a file inside the source store by absolute path.

### What the reader rejects

`extractArchive` verifies the whole archive before import can see any of it. It copies each blob into `<userData>/staging/<token>/blobs/` and checks its hash as it goes. It rejects the archive, and deletes the staging folder, when any of these is true:

- The file is not gzip, the tar is truncated, or data follows the end-of-archive marker.
- An entry is not a regular file (symlinks, directories, pax and GNU headers), uses the ustar name prefix, or has a bad header checksum.
- The first entry is not `manifest.json`, or the manifest fails `parseManifest`. The manifest check covers the version and format, unknown agents and roles, a role under the wrong agent, absolute paths, `.` and `..`, empty segments, backslashes, NUL, characters outside `[A-Za-z0-9_.@+=-]`, duplicate sessions or paths, malformed hashes, and one hash listed with two sizes.
- A later entry is not `blobs/<sha256>` for a hash the manifest names, repeats a blob, has the wrong size, or does not match its hash.
- A blob the manifest names is missing.
- A limit in `ArchiveLimits` is exceeded: manifest bytes, bytes per entry, total bytes (checked against the manifest and while unpacking, which stops gzip bombs), or the entry count.

### Writing

Export writes to a hidden temp file next to the destination, fsyncs it, and renames it into place. Each blob is re-read and re-hashed while it streams. If a source file changed after it was collected, the export fails rather than writing a manifest that does not match its blobs.

## Providers

A provider owns one agent's store. Core never branches on the agent. The registry in `src/main/providers/registry.ts` is a full `Record<AgentId, Provider>`: `claude-code` in `src/main/providers/claude-code/` and `codex` in `src/main/providers/codex/`. An archive that names any other agent fails `parseManifest`, so core has no unsupported-agent path.

```ts
export interface Provider {
  readonly agent: AgentId
  readonly factsVersion: number
  storeRoot(env: ProviderEnv): string
  discover(root: string, env: ProviderEnv, scan?: Scan): Promise<SessionSummary[]>
  collect(root: string, id: string, env: ProviderEnv, once?: ReadOnce): Promise<CollectedSession>
  inspectTarget(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection>
  readonly transcriptRole: FileRole
  findTranscript(root: string, id: string, env: ProviderEnv): Promise<TranscriptFile | null>
  previewTranscript(file: TranscriptFile, budget?: ReadBudget): Promise<TranscriptPreview>
  applyEffect(root: string, effect: ProviderEffect): Promise<void>
  undoEffect(root: string, effect: ProviderEffect): Promise<void>
}
```

- `discover` takes every fact it reads from a file through `scan.facts`, so a later pass can skip the file. See [Listing sessions](#listing-sessions).
- `discover` and `collect` are read-only. They get the environment because a store can span folders (Codex reads `CODEX_SQLITE_HOME`). `collect` returns snapshot files. For an append-only file, the snapshot stops at the last newline. A snapshot can also be a byte range (`start`), for a blob that is one line of a shared file such as Codex's `session_index.jsonl`. Codex `collect` throws for a subagent that belongs to another session and names that session, so export carries a subagent only inside its owner.
- `inspectTarget` is read-only too. It returns either a refusal, or the list of `TargetFile`s with the store path each one lands at, an optional `ContentTransform`, and the mtime to set. The provider computes every target path from parts it has validated. A name from the archive is used only after it matches a whitelist. `ImportContext.readBlob` streams a verified archive blob, for a provider that derives an effect from file content (the Codex `threads` row).
- `ReadOnce` shares store reads across the sessions of one operation. Export passes one shared `once` to every `collect`, and import preview puts one in `ImportContext.once` for every `inspectTarget`, so a provider walks its store, reads its lock files, and copies the Codex database once per operation instead of once per session. Each import gets `readFresh`, because the import before it changed the store. Wrap any read that does not depend on the session, keyed by a name that starts with the agent id, such as `codex:rollouts`.
- A `TargetFile` can name `supersedes`, a file at another path that holds the current copy in another form, with a `decode` transform. Codex uses it when this machine holds a rollout as `.jsonl.zst` and import writes the plain `.jsonl`.
- A `ContentTransform` must be deterministic, because preview hashes its output and import checks that the bytes it writes hash the same.
- `transcriptRole`, `findTranscript`, and `previewTranscript` serve the Conversation preview. See [Previewing a conversation](#previewing-a-conversation).
- `ProviderEffect` is for writes that are not files, such as the Codex `threads` row. An effect is plain JSON. The journal records it before `applyEffect` runs, so `undoEffect` must work from the JSON alone, must be safe if the effect never ran, and must be safe to run twice. A provider parses the effect again in `undoEffect`, because recovery reads it back from disk.

## Listing sessions

`createDiscovery` in `src/main/core/discovery.ts` lists one agent's store per call. The service keeps one `Discovery` for the app's lifetime. A list call that arrives while that agent's pass runs waits for a new pass that starts after the running one, because the running pass may have read its folders before a new session appeared.

### Listing never hashes

Hashes exist for export. `discover` takes sizes from `stat` and reads only the records it needs. `collect` reads the snapshot and hashes it, as before.

### A long transcript is read in part

`readWindow` in `src/main/core/window.ts` reads a transcript within a `ReadBudget`. Listing uses `LIST_BUDGET`. It reads a transcript up to 32 MB whole, and a longer one as its first 28 MB and its last 4 MB. A `.jsonl.zst` rollout has no random access, so it streams through zstd and only that window reaches the parser. A half-written last line is never read.

The head holds the session id, the first prompt, the first cwd, the client, the version, and Codex `session_meta` with its subagent links. The tail holds the last activity and the latest cwd. Facts that need every line are best-effort for a transcript over the budget:

- `cwds` lists only the folders in the parts read, and `SessionSummary.cwdsComplete` is `false`. The detail panel says so.
- A title record that appears only in the middle is missed. Claude Code writes `ai-title` records again every few turns, so the tail usually holds the newest one.

`collect` reads every line, so an archive's `cwds` is always complete. On the 1.09 GB benchmark store, a 16 MB budget saved another 150 ms on a cold pass, and a 64 MB budget cost 80 ms. A 32 MB budget keeps the facts exact for every transcript under that size.

### Facts are cached per file

A provider calls `scan.facts(kind, file, derive)`. `derive` reads the file only when no facts are kept for that `kind`, absolute path, size, and mtime. The kinds are `transcript`, `subagent`, and `subagent-meta` for Claude Code, and `rollout` and `history-base` for Codex. A Codex session combines several files, so the cache keeps per-file facts, never whole summaries.

`FactsCache` in `src/main/core/facts-cache.ts` keeps each agent's facts in `<userData>/discovery/<agent>.json`:

```json
{ "format": "agent-sessions-discovery-cache", "version": 1, "factsVersion": 1, "budget": { "maxBytes": 33554432, "tailBytes": 4194304 },
  "entries": [["transcript", "/Users/alice/.claude/projects/-Users-alice-proj/<uuid>.jsonl", 52311, 1793000000000.123, { "cwds": ["/Users/alice/proj"], "…": "…" }]] }
```

- An entry is used only while its file has the same size and mtime. A rewrite that keeps the size still moves the mtime.
- A pass keeps only the entries it used or made, so facts for a file that vanished drop with the next pass. A different file at the same path is read again.
- A file with another `format`, layout `version`, provider `factsVersion`, or `budget` is ignored. Bump a provider's `factsVersion` when what its `discover` derives from a file changes.
- A missing, unreadable, or corrupt file gives an empty cache. If kept facts make a provider throw, the pass reads every file once more before it reports a problem.
- The cache is written to a temp file and renamed into place, and only when a pass changed something. A failed write is ignored.
- The cache holds titles, first prompts, and folders from the stores on this machine, in this machine's app data.

### Progress names the files a pass must read

A provider names the files it will take facts from with `scan.expect(kind, files)`. Only files the cache cannot answer for count. While it reads, the pass sends a `ScanProgress` on the `onProgress` channel at most every 100 ms, and once more when the last file is done:

```ts
interface ScanProgress {
  operation: 'scan'
  agent: AgentId
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** Store-relative path of the file being read. */
  current: string | null
}
```

`bytesTotal` is the sum of file sizes on disk. A transcript over the budget counts its whole size, though listing reads only its window. A pass with nothing to read sends no event, so a refresh that finds nothing new shows nothing.

### Measured cost

`pnpm bench:discover` builds a synthetic store once per spec version: 571 session files, 1.09 GB, four over 100 MB, one of them a `.jsonl.zst` of image payloads. It times each agent cold, after a relaunch, on a refresh, and on a refresh after one file changed, with the longest event-loop stall. `AGENT_SESSIONS_BENCH_REAL=1` also times this machine's real stores, read-only. Each run writes `artifacts/bench/<store>-<commit>.json`.

| Median of 5 | Before | Cold | Relaunch | Refresh, one change |
| --- | --- | --- | --- | --- |
| Synthetic store, 1.09 GB | 2404 ms | 1754 ms | 37 ms | 50 ms |
| Real stores on the dev Mac, 7 Claude Code and 47 Codex sessions | 1617 ms | 1293 ms | 11 ms | not run, the benchmark never writes to them |

A cold Codex pass is bound by zstd. Decompression alone takes about 60% of it. The longest stall was 7 ms on the synthetic store and 14 ms on the real one, so parsing stays on the main thread.

## Previewing a conversation

The Conversation tab and the import preview show what a session said: its first entry, how many entries are left out, and its newest 24. `SessionPreview` in `src/shared/sessions.ts` is that shape, or `unavailable` with a plain reason. Text is plain and whitespace-collapsed, and a message is capped at 600 characters. A tool call is one line, such as `Read src/main/index.ts` or `Ran pnpm test`. Subagent conversations are not previewed.

One parser per agent serves both sources. For a session on this machine, `findTranscript` names its main transcript, the same file `discover` reads. For a session in an open archive, core picks the session's one file whose role is `transcriptRole` (`transcript` or `rollout`) and hands its verified staged blob to the same `previewTranscript`. Core also passes the store path from the manifest, so the provider can tell a `.jsonl.zst` from a plain file.

`readPreview` in `src/main/core/preview.ts` feeds the provider's line reader through `readWindow` within `PREVIEW_BUDGET`. A transcript up to 64 MB is read whole, so its counts are exact. Parsing every line of a 36 MB real rollout took about 76 ms. A longer plain file is read as its first 60 MB and its last 4 MB, by range. A `.jsonl.zst` rollout has no random access, so it streams through zstd and only the same window reaches the parser. When the middle is skipped, `complete` is false and the counts are lower bounds. A half-written last line and the cut lines at either edge of a window are left out. A line the reader cannot use gives no entries. A line that makes the reader throw counts the same way. So a transcript of garbage is `unavailable`, never an error. A damaged `.zst` is `unavailable` too.

- **Claude Code** (`providers/claude-code/preview.ts`). The parser reads only `user` and `assistant` records. It skips meta, sidechain, and compact-summary records, and also user records that hold tool results or start with a tag (slash commands, hook output, reminders). An assistant record gives its text blocks as one reply and each `tool_use` as a line built from the tool's most telling input: `file_path` (relative to the record's `cwd`), the first line of `command`, `pattern`, `url`, `query`, or `description`.
- **Codex** (`providers/codex/preview.ts`). The parser reads only `response_item` records, since `event_msg` repeats them. User `input_text` parts that start with a tag are injected context and are skipped. Developer messages and reasoning are skipped. `function_call`, `custom_tool_call`, `local_shell_call`, and `web_search_call` each give one line: the shell command, the files an `apply_patch` touches, the first `cmd` in a code-mode `exec` script, or the search. A subagent rollout starts with a copy of its parent's history, so records below `subagent_history_start_ordinal` are skipped.

## Planning an import

Planning has no side effects. `previewImport` runs it for display, and `runImport` runs it again on the current state just before it writes.

1. Core resolves each mapping target that exists to its real path (macOS `/tmp` becomes `/private/tmp`).
2. The provider inspects the target store. The Claude provider refuses a session whose layout is not what export writes (`invalid-session`), whose start cwd has no mapping (`unmapped-cwd`), or whose id appears in two project folders (`multiple-copies`). If the id is in one folder, that folder is the target, even when the mapping points elsewhere, because a second copy would break `claude --resume <id>`. The Codex provider refuses the same three cases, with `multiple-copies` meaning one rollout id in two places. It also refuses `newer-here` when this machine holds a newer rollout of the thread, or of one of its subagent threads, than the archive. A provider refusal is always `blocked`, because no choice in the UI can fix it. It refuses `invalid-session` for a `subagent-rollout` that no thread of the session spawned. A rollout that exists here is updated where it is, in either form.
3. For each target file, core checks that the path resolves inside the store root after symlinks (`unsafe-path` otherwise). It hashes the bytes import would write and the existing file, and `relate` classifies them as `absent`, `identical`, `target-is-prefix`, `target-is-longer`, or `different`. When the path is absent and the file names `supersedes`, the existing file is the superseded one, read through its `decode`.
4. `planSession` in `planner.ts` is pure. A live session is `blocked`. Any `different` file is `conflict: diverged`, and otherwise any `target-is-longer` file is `conflict: target-newer`. If every file is identical, the plan is `skip-identical`. If every file is absent, it is `create`. Otherwise it is `update`, which replaces prefix files and adds missing ones.

A conflict plan writes nothing. It also carries `replace`, the writes and effects for the user's other choice: back up every file that differs and write the archive copy, as an update does, plus create the missing ones. `changesFor(plan, choice)` picks one. A conflict action also carries `hereChangedAt`, the newest mtime among the differing files here, so the UI can show when each copy last changed.

The import screen leads with a verdict line, such as `1 will be added · 2 need a decision · 4 already here`, which a screen reader hears when planning finishes. Conflicts are listed first, then what import writes, then blocked sessions. Identical sessions fold into one line at the end. Only an add or update has a checkbox. The Folders section lists only folders that may receive files: a folder whose sessions are all identical, blocked, or kept needs no mapping, and sits behind **Show other folders**. A missing folder offers **Create folder** and a hint to clone the repo and check out its branch, with the checkout command copyable.

The UI renders `ImportAction` from `src/shared/sessions.ts` directly. Conflict and blocked messages name no store paths. The plan and the result use the same verbs (Add and Added, Update and Updated, Replace and Replaced), from `src/renderer/src/model/importing.ts`. A row that imports nothing shows no warnings, and a missing folder that the Folders section already lists points there instead of repeating the path. Esc leaves the import screen like Cancel, except while the import runs or when focus is in a text field, and Cmd/Ctrl+Enter starts the import when its button is enabled. The title leads with the session count and the source platform, since the manifest records no computer name, and the file name sits under it.

The result screen (`model/result.ts`) is a checklist per project folder. Each folder that import wrote to gets a panel with its path, the branches its sessions were on, and whether the folder exists here. A folder that does not exist yet leads, with a hint to clone the repo and check out its branch, since the archive records no repo URL. Under it are the sessions with their resume commands. Sessions import did not write (identical, a conflict kept as it is here, blocked, or unticked) stay in a folded line below, so the result accounts for every session in the archive. `runImport` returns outcomes only for the sessions it was sent, so the renderer takes the others from the plan the user ran. The result screen's one exit, Back to sessions, sits in its header.

## Executing an import

`executePlan` in `executor.ts` imports one session as one transaction. A failure in one session does not undo sessions that already committed in the same run.

For each write:

1. Create missing folders one by one, journaling each before it is made.
2. Stream the blob through the transform into `.<name>.<runId>.tmp` in the target folder. Then fsync it, check its hash against the plan, and set its mtime.
3. For an update, re-hash the existing file, journal the backup, and move the file to `<userData>/backups/<runId>/<agent>/<store path>`. The move is a rename, or a copy and delete across volumes. Then re-hash the backup. When the update replaces a superseded file, that file is the one backed up, under its own store path.
4. Journal the publish, then call `link(temp, final)`, which is atomic and never overwrites. Unlink the temp and fsync the folder.

Provider effects run after the files. Deleting the journal is the commit point.

The journal is `<userData>/journal/<runId>-<key>.journal.jsonl`. Its first line is a header naming the agent, store root, and backup folder. Every later line is written and fsynced before the change it describes. Rollback reads the journal backward. Each undo checks the current state first, so it is safe at every crash point and safe to repeat:

| Step | Undo |
| --- | --- |
| `mkdir` | Remove the folder if it is empty. |
| `temp` | Delete the temp file if it exists. |
| `backup` | If the backup exists and the original path is free, move it back. |
| `publish` | Delete the file only if its hash is the one this run wrote. |
| `effect` | `provider.undoEffect`. |

If every undo succeeds, the journal is deleted. Otherwise it stays for the next attempt. At startup, `recoverJournals` rolls back every journal it finds before the IPC handlers are registered, because a journal that still exists belongs to an import that never committed. Recovery refuses a journal step whose path is outside its store root or backup folder.

Tests inject a `Fault` (`{ afterWrites, mode: 'error' | 'crash' }`). `error` exercises the in-process rollback. `crash` leaves the journal behind for `recoverJournals`.

## IPC contract

`src/shared/ipc.ts` declares `DesktopApi`. Every call returns `ApiResult<T>`, which is `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. The error codes are `invalid-input`, `unknown-archive`, `invalid-archive`, `busy`, and `io`.

| Call | Main does |
| --- | --- |
| `listSessions(agent)` | Lists one agent's store, reading only files that changed since the last pass. It returns that agent's `SessionList`. A store that fails goes in `problems`. The renderer asks for every agent at once and shows each as it answers. |
| `exportSessions(keys)` | Validates the keys, shows the save dialog, and writes the archive. It returns `cancelled`, or `saved` with counts and `liveKeys`. The UI should warn about live sessions and private content. |
| `openArchive()` | Shows the open dialog, verifies and stages the archive, and returns a token, an `ArchiveSummary`, and suggested `PathMapping`s. Only one archive is open at a time, so opening another closes the previous one. |
| `previewImport(token, mappings)` | Returns an `ImportAction`, the target cwd, and warnings (`target-cwd-missing`, `hidden-from-picker`) for every session in the archive. |
| `previewSession(key)` | Validates the key and previews that session's main transcript on this machine. It returns `SessionPreview`, which is `unavailable` when the session is no longer here. |
| `previewArchiveSession(token, key)` | Validates both and previews the session's transcript from the open archive's staged blob. A key the archive does not hold is `invalid-input`. |
| `runImport(token, mappings, requests)` | Takes one `ImportRequest` per session, `{ key, onConflict: 'skip' \| 'replace' }`. Plans again, then imports each one. A session that plans as a conflict is replaced only when its request says `replace`, and is `refused` otherwise. It returns one `SessionImportOutcome` per request: `created`, `updated` or `replaced` (with the backup folder), `skipped`, `refused`, or `failed` (with `rolledBack`). The result also names the run's backup folder, or `null` when nothing was replaced. |
| `createFolder(token, target)` | Validates the token and that `target` is an absolute path, then creates the folder and any missing parents (`mkdir -p`). An existing folder is left as it is. A file in the way, a denied permission, or a read-only disk is `io` with a short message the mapping row shows. The import screen offers it as **Create folder** on a mapping whose folder does not exist yet, then plans again. |
| `storeRoots()` | Returns the store folder each provider reads, for the empty state. |
| `chooseFolder(startIn)` | Shows the folder picker for a path mapping and returns the chosen folder, or `null`. |
| `revealExport()` | Reveals the last archive that main saved. It takes no path from the renderer. |
| `revealBackups()` | Reveals the backup folder of the last import run that replaced files. Like `revealExport`, it takes no path. |
| `copyText(text)` | Writes a string of up to 64 KB to the clipboard. |
| `onProgress(callback)` | Subscribes to `ProgressEvent`s from listing (`scan`), export, open, and import. It returns the unsubscribe function. |

Only one export, open, preview, or import runs at a time. Another call returns `busy`. Listing and the two conversation previews only read, so they skip that lock and run beside an export or import. `createFolder` skips it too, because it only adds an empty folder. A suggested mapping keeps a path that exists on this machine. Otherwise it swaps the source home folder for this machine's home folder and converts separators. A session records every folder it ran in, but a folder inside another suggested one gets no mapping of its own when the outer mapping already places it where its own suggestion would, because a mapping applies to every path under its source. So a project shows one row, not one per subfolder. Mapping targets must be absolute paths. The mapping field shows a target under this home as `~/…` and expands a typed `~` back to the home folder, so main still receives an absolute path. The renderer chooses targets, but they only become folder names through `encodeProjectDir` and values written into the rewritten fields. Main uses them to write only through `createFolder`, which makes empty folders and never changes anything that exists.

## Tests

`pnpm test` runs vitest on `test/`. `test/fixtures/claude-store.ts` builds synthetic Claude stores in temp folders: several projects, a path longer than 200 characters, subagents, tool results, an `sdk-cli` session, a half-written last line, a live registry entry, set-aside copies, and every never-export file carrying a marker string. `treeHash` hashes a whole folder, so a test can prove a store is byte-identical after a rollback or an export.

`test/discover-window.test.ts` checks that `readWindow` stays within its budget, that a long Claude transcript and a long Codex rollout (plain and `.jsonl.zst`) are listed from their head and tail with `cwdsComplete: false`, and that every session within the budget lists the same fields an export derives. `test/discovery-cache.test.ts` checks that a cached pass lists exactly what a full read lists, that an unchanged file is not read again (it is made unreadable and must still list), that a changed or replaced file is read again, and that a corrupt, outdated, or malformed cache is rebuilt. `test/discovery-progress.test.ts` checks the progress counts and the per-agent service call. `test/e2e/scan-ui.e2e.test.ts` slows the scan with `AGENT_SESSIONS_E2E_SCAN_PACE` and drives the progress panel, the status bar line, a preview during a scan, and refresh on focus, from the button, and with Cmd/Ctrl+R.

`test/claude-preview.test.ts` and `test/codex-preview.test.ts` check each preview parser on synthetic transcripts, including a transcript over a reduced budget, where the skipped middle must not be counted. `test/preview-service.test.ts` checks the two IPC calls, their input validation, and that a preview runs while an export holds the lock. `test/create-folder.test.ts` checks that `createFolder` makes nested folders, leaves an existing folder and its files alone, rejects a relative or malformed path and a closed archive, and reports a file in the way or a denied permission.

`test/fixtures/codex-store.ts` builds a synthetic Codex store: dated and archived rollouts, a `.jsonl.zst` rollout, a reverted thread with a `_<rolloutId>` file, a fork child and its `history_base` parent, a parent with two subagents (one with its own subagent) whose rollouts repeat the parent's history, an orphan subagent, generated images, `session_index.jsonl`, a writer lock, and the never-export files. `test/fixtures/codex-db.ts` creates `state_5.sqlite` with the real `threads` table, its triggers, and `thread_spawn_edges`. Codex rollback tests wrap the real provider so a fault fires right before or after a real effect.

A conflict is covered at each layer. `test/planner.test.ts` checks the `replace` changes a conflict plan carries. `test/roundtrip.test.ts` and `test/codex-roundtrip.test.ts` check that a conflict keeps the copy here by default and that Replace moves it to the backup folder. `test/rollback.test.ts` checks that a Replace that fails partway restores it. `test/import-choices.test.ts` checks which sessions the import screen sends and with which choice. `test/import-result.test.ts` checks how the result groups sessions by folder and keeps the ones import did not write.

---
summary: The archive format, the import planner and executor, the provider contract, and the IPC calls that move sessions between machines.
read_when:
  - Adding a provider or changing what a provider exports or writes
  - Changing the archive format or its limits
  - Building UI on top of the session IPC calls
  - Debugging an import that failed, rolled back, or was refused
---

# Moving sessions between machines

[Session storage and transfer rules](session-storage.md) says what each agent stores and what import must do. This doc says how the code does it. The code is in `src/main/core/`, `src/main/archive/`, and `src/main/providers/`.

## Archive format

An archive is one `*.agentsessions` file: a gzip-compressed ustar tar. The first entry is `manifest.json`. Every other entry is `blobs/<sha256>`, one per distinct file content, so two sessions that share a file store it once.

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
      "createdAt": "…", "lastActivity": "…", "cliVersion": "2.1.319",
      "files": [{ "role": "transcript", "path": "projects/-Users-alice-proj/<uuid>.jsonl", "sha256": "…", "size": 1234, "mtimeMs": 0 }]
    }
  ]
}
```

`files[].path` is relative to the source store and always uses `/`. `ROLES_BY_AGENT` lists the roles each agent may use: `transcript`, `subagent`, and `tool-result` for Claude Code, and `rollout`, `linked-rollout`, `generated-image`, and `index-entry` for Codex. `source.storeRoots` was added beyond the original brief. Import needs it to rewrite `toolUseResult.persistedOutputPath`, which names a file inside the source store by absolute path.

### What the reader rejects

`extractArchive` verifies the whole archive before import can see any of it. It copies each blob into `<userData>/staging/<token>/blobs/` and checks its hash as it goes. It rejects the archive, and deletes the staging folder, when any of these is true:

- The file is not gzip, the tar is truncated, or data follows the end-of-archive marker.
- An entry is not a regular file (symlinks, directories, pax and GNU headers), uses the ustar name prefix, or has a bad header checksum.
- The first entry is not `manifest.json`, or the manifest fails `parseManifest`. The manifest check covers the version and format, unknown agents and roles, a role under the wrong agent, absolute paths, `.` and `..`, empty segments, backslashes, NUL, characters outside `[A-Za-z0-9_.@+=-]`, duplicate sessions or paths, malformed hashes, and one hash listed with two sizes.
- A later entry is not `blobs/<sha256>` for a hash the manifest names, repeats a blob, has the wrong size, or does not match its hash.
- A blob the manifest names is missing.
- A limit in `ArchiveLimits` is exceeded: manifest bytes, bytes per entry, total bytes (checked against the manifest and while unpacking, which stops gzip bombs), or the entry count.

### Writing

Export writes to a hidden temp file next to the destination, fsyncs it, and renames it into place. Each blob is re-read and re-hashed while it streams. If a source file changed after it was collected, the export fails rather than writing a manifest that lies.

## Providers

A provider owns one agent's store. Core never branches on the agent. The registry in `src/main/providers/registry.ts` is a full `Record<AgentId, Provider>`: `claude-code` in `src/main/providers/claude-code/` and `codex` in `src/main/providers/codex/`. An archive that names any other agent fails `parseManifest`, so core has no unsupported-agent path.

```ts
export interface Provider {
  readonly agent: AgentId
  storeRoot(env: ProviderEnv): string
  discover(root: string, env: ProviderEnv): Promise<SessionSummary[]>
  collect(root: string, id: string, env: ProviderEnv): Promise<CollectedSession>
  inspectTarget(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection>
  applyEffect(root: string, effect: ProviderEffect): Promise<void>
  undoEffect(root: string, effect: ProviderEffect): Promise<void>
}
```

- `discover` and `collect` are read-only. They get the environment because a store can span folders (Codex reads `CODEX_SQLITE_HOME`). `collect` returns snapshot files. For an append-only file, the snapshot stops at the last newline. A snapshot can also be a byte range (`start`), for a blob that is one line of a shared file such as Codex's `session_index.jsonl`.
- `inspectTarget` is read-only too. It returns either a refusal, or the list of `TargetFile`s with the store path each one lands at, an optional `ContentTransform`, and the mtime to set. The provider computes every target path from parts it has validated. A name from the archive is used only after it matches a whitelist. `ImportContext.readBlob` streams a verified archive blob, for a provider that derives an effect from file content (the Codex `threads` row).
- A `TargetFile` can name `supersedes`: a file at another path that holds the current copy in another form, with a `decode` transform. Codex uses it when this machine holds a rollout as `.jsonl.zst` and import writes the plain `.jsonl`.
- A `ContentTransform` must be deterministic, because preview hashes its output and import checks that the bytes it writes hash the same.
- `ProviderEffect` is for writes that are not files, such as the Codex `threads` row. An effect is plain JSON. The journal records it before `applyEffect` runs, so `undoEffect` must work from the JSON alone, must be safe if the effect never ran, and must be safe to run twice. A provider parses the effect again in `undoEffect`, because recovery reads it back from disk.

## Planning an import

Planning has no side effects. `previewImport` runs it for display, and `runImport` runs it again on the current state just before it writes.

1. Core resolves each mapping target that exists to its real path (macOS `/tmp` becomes `/private/tmp`).
2. The provider inspects the target store. The Claude provider refuses a session whose layout is not what export writes (`invalid-session`), whose start cwd has no mapping (`unmapped-cwd`), or whose id appears in two project folders (`multiple-copies`). If the id is in one folder, that folder is the target, even when the mapping points elsewhere, because a second copy would break `claude --resume <id>`. The Codex provider refuses the same three cases, with `multiple-copies` meaning one rollout id in two places. It also refuses `diverged` when this machine holds a newer rollout of the thread than the archive. A rollout that exists here is updated where it is, in either form.
3. For each target file, core checks that the path resolves inside the store root after symlinks (`unsafe-path` otherwise). It hashes the bytes import would write and the existing file, and `relate` classifies them as `absent`, `identical`, `target-is-prefix`, `target-is-longer`, or `different`. When the path is absent and the file names `supersedes`, the existing file is the superseded one, read through its `decode`.
4. `planSession` in `planner.ts` is pure. A live session is `blocked`. Any `different` file is `conflict: diverged`, and any `target-is-longer` file is `conflict: target-newer`. If every file is identical, the plan is `skip-identical`. If every file is absent, it is `create`. Otherwise it is `update`, which replaces prefix files and adds missing ones.

The UI renders `ImportAction` from `src/shared/sessions.ts` directly.

## Executing an import

`executePlan` in `executor.ts` imports one session as one transaction. A failure in one session does not undo sessions that already committed in the same run.

For each write:

1. Create missing folders one by one, journaling each before it is made.
2. Stream the blob through the transform into `.<name>.<runId>.tmp` in the target folder. Then fsync it, check its hash against the plan, and set its mtime.
3. For an update, re-hash the existing file, journal the backup, and move the file to `<userData>/backups/<runId>/<agent>/<store path>`. The move is a rename, or a copy and delete across volumes. Then re-hash the backup. When the update replaces a superseded file, that file is the one backed up, under its own store path.
4. Journal the publish, `link(temp, final)` (atomic, never overwrites), unlink the temp, and fsync the folder.

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
| `listSessions()` | Discovers every provider's store. It returns `SessionList`, and a store that fails goes in `problems` without hiding the others. |
| `exportSessions(keys)` | Validates the keys, shows the save dialog, and writes the archive. It returns `cancelled`, or `saved` with counts and `liveKeys`. The UI should warn about live sessions and private content. |
| `openArchive()` | Shows the open dialog, verifies and stages the archive, and returns a token, an `ArchiveSummary`, and suggested `PathMapping`s. Only one archive is open at a time, so opening another closes the previous one. |
| `previewImport(token, mappings)` | Returns an `ImportAction`, the target cwd, and warnings (`target-cwd-missing`, `hidden-from-picker`) for every session in the archive. |
| `runImport(token, mappings, keys)` | Plans again, then imports each selected session. It returns one `SessionImportOutcome` per key: `created`, `updated` (with the backup folder), `skipped`, `refused`, or `failed` (with `rolledBack`). |
| `storeRoots()` | Returns the store folder each provider reads, for the empty state. |
| `chooseFolder(startIn)` | Shows the folder picker for a path mapping and returns the chosen folder, or `null`. |
| `revealExport()` | Reveals the last archive that main saved. It takes no path from the renderer. |
| `copyText(text)` | Writes a string of up to 64 KB to the clipboard. |
| `onProgress(callback)` | Subscribes to `ProgressEvent`s from export, open, and import. It returns the unsubscribe function. |

Only one export, open, preview, or import runs at a time. Another call returns `busy`. A suggested mapping keeps a path that exists on this machine. Otherwise it swaps the source home folder for this machine's home folder and converts separators. Mapping targets must be absolute paths. The renderer chooses targets, but they only become folder names through `encodeProjectDir` and values written into the rewritten fields. Main never uses them to read or write a file.

## Tests

`pnpm test` runs vitest on `test/`. `test/fixtures/claude-store.ts` builds synthetic Claude stores in temp folders: several projects, a path longer than 200 characters, subagents, tool results, an `sdk-cli` session, a half-written last line, a live registry entry, set-aside copies, and every never-export file carrying a marker string. `treeHash` hashes a whole folder, so a test can prove a store is byte-identical after a rollback or an export.

`test/fixtures/codex-store.ts` builds a synthetic Codex store: dated and archived rollouts, a `.jsonl.zst` rollout, a reverted thread with a `_<rolloutId>` file, a fork child and its `history_base` parent, a subagent thread, generated images, `session_index.jsonl`, a writer lock, and the never-export files. `test/fixtures/codex-db.ts` creates `state_5.sqlite` with the real `threads` table and triggers. Codex rollback tests wrap the real provider so a fault fires right before or after a real effect.

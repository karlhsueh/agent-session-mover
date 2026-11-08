---
summary: Where Claude Code and Codex store sessions, what a resume needs, and the rules Agent Sessions follows to export and import them.
read_when:
  - Changing discovery, export, or import for any agent
  - Adding an agent or client
  - Deciding whether a session type is portable
---

# Session storage and transfer rules

This doc is the spec for the providers in `src/main/providers/`. It records what was observed on Claude Code CLI 2.1.319 and Codex CLI 0.162.1 on macOS in November 2026. Each claim carries a label:

- **Verified** means it was observed on disk or in an experiment with the real CLI.
- **Documented** means an official doc or the Codex source says so.
- **Inferred** means it follows from evidence but nobody has tested it.

Both agents change their storage between versions. Claude's docs call the transcript format internal. Recheck this doc when a provider test fails on a new CLI version.

## What transfers and what does not

| Session type | Portable | Why |
| --- | --- | --- |
| Claude Code CLI, desktop Code tab (local), VS Code extension | Yes | All three write to the same `projects/` store. Verified for CLI and desktop, documented for VS Code. |
| Claude Code web, `--cloud`, cloud desktop sessions, routines | No | They live on Anthropic servers. `claude --teleport` copies one down, after which it is a local session. |
| Claude desktop Cowork sessions | No | Each one has its own config dir inside the desktop app's VM. |
| Codex CLI (`codex`, `codex exec`) and Codex desktop app | Yes | Both use `~/.codex`. Verified. |
| Codex IDE extension | Probably | Not installed on the test machine. Its source tag `vscode` suggests the same store. Inferred. |
| Codex ChatGPT-hosted threads and Codex Cloud tasks | No | They have no local rollout file. |

A session that resumes in one client is not automatically resumable in another. Agent Sessions reports the client that created a session and never claims cross-client resume beyond what this doc marks verified.

## Claude Code

### Store layout

The store root is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset. On Windows it is `%USERPROFILE%\.claude`.

| Artifact | Path | Exported | Notes |
| --- | --- | --- | --- |
| Transcript | `projects/<enc>/<sessionId>.jsonl` | Yes | The only file a resume needs. Verified. |
| Subagent transcripts | `projects/<enc>/<sessionId>/subagents/agent-*.jsonl` and `agent-*.meta.json` | Yes | Not needed for the main resume. |
| Tool-result spill files | `projects/<enc>/<sessionId>/tool-results/*` | Yes | The transcript points at them by absolute path. |
| File checkpoints | `file-history/<sessionId>/` | No | Needed only for `/rewind`. Holds full file contents. |
| Prompt history | `history.jsonl` | No | Feeds the up-arrow only. |
| Set-aside copies | `*.orphaned-*`, `*.superseded-*` | No | Claude Code hides them. |
| Credentials, config, runtime state | Keychain item `Claude Code-credentials`, `.credentials.json`, `~/.claude.json`, `backups/`, `sessions/`, `shell-snapshots/`, `session-env/`, `paste-cache/` | Never | Secrets, account data, or machine-local state. |
| Desktop list metadata | `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json` | No | Holds the desktop app's own title and list state. |

### Project folder name

`<enc>` is the session's working directory with every character that is not an ASCII letter or digit replaced by `-`. If the result is longer than 200 characters, Claude Code keeps the first 200, then adds `-` and the base-36 absolute value of a Java-style string hash of the full path. Verified against the CLI binary and two real long folders. The encoding cannot be reversed, so read the real working directory from the transcript's `cwd` fields.

Encode the real path. On macOS, `/tmp` resolves to `/private/tmp`, and Claude Code records the resolved form.

### Transcript records

Each line is one JSON object. Conversation records (`user`, `assistant`, `attachment`, `system`, `progress`) carry `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, and `entrypoint`. Metadata records such as `ai-title`, `custom-title`, `last-prompt`, and `session-owner` carry no `cwd`.

- **Title.** Use `custom-title`, then `ai-title`, then the first user prompt.
- **Client.** `entrypoint` is `cli`, `claude-desktop`, `claude-vscode`, `sdk-cli` (`claude -p`), or `sdk-ts`.
- **Hidden sessions.** The `/resume` picker and plain `--continue` hide `sdk-cli` sessions. `claude --resume <id>` still finds them. Verified.
- **Several working directories.** A resume from another folder appends records with the new `cwd`, so one transcript can hold several.

### Resume rules

- `claude --resume <id>` searches the current project folder first, then every project folder. Verified.
- The picker and `--continue` list only the transcripts that sit in the current folder's `<enc>` folder. Placement decides visibility, not the `cwd` fields. Verified.
- `--continue` picks the newest file by modification time, not by record timestamp. Verified.
- If the same session id exists in two project folders other than the current one, `--resume <id>` reports `No conversation found`. Verified. That makes `sessionId` the conflict key across the whole store.
- Resume works with stale `cwd` fields, mismatched account ids, and a half-written last line. Verified.
- A session that was never trusted in the target folder shows the trust dialog on the first interactive run. Agent Sessions does not edit `~/.claude.json` to skip it.

### Import

1. Place the transcript at `projects/<enc(target cwd)>/<sessionId>.jsonl` and its sidecar folder next to it.
2. Rewrite only these structured fields, and only when the value equals a mapped source path or sits under one:
   - the top-level `cwd` of each record
   - `attachment.snapshot.workingDirectory`
   - `toolUseResult.persistedOutputPath`, which moves from the old store prefix to the new one
3. Leave tool inputs, tool outputs, and message text unchanged. Rewriting free text can corrupt content, and resume does not need it.
4. Set the file's modification time to its last record timestamp, so the import does not pretend to be the newest session.
5. Drop any unparsable trailing line before writing.

## Codex

### Store layout

The store root is `$CODEX_HOME`, or `~/.codex` when that is unset. On Windows it is `%USERPROFILE%\.codex`. The SQLite files live in the same folder unless `CODEX_SQLITE_HOME` or the `sqlite_home` config key moves them.

| Artifact | Path | Exported | Notes |
| --- | --- | --- | --- |
| Rollout | `sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl`, or `.jsonl.zst` | Yes, byte for byte | The source of truth. A reverted thread adds `_<rolloutId>` to the name. |
| Archived rollout | `archived_sessions/rollout-*.jsonl[.zst]` | Yes | Flat, with no date folders. |
| Linked earlier rollout | Any rollout named by `session_meta.history_base.thread_id` | Yes, byte for byte | The child points into it by byte offset. |
| Thread index | `state_5.sqlite`, table `threads` | Row fields only | Import writes a new row. See below. |
| Generated images | `generated_images/<threadId>/` | Yes | Rollouts point at them by absolute path. |
| Thread names | `session_index.jsonl` | The matching line | Needed only for `codex resume <name>`. |
| History cache | `thread_history_1.sqlite` | No | Codex rebuilds it from the rollout. Verified. |
| Credentials, config, runtime state | `auth.json`, `config.toml`, `.codex-global-state.json`, `shell_snapshots/`, `history.jsonl`, `logs_2.sqlite`, `installation_id`, `app-server-*`, `ipc/` | Never | Secrets, tokens, account ids, or machine-local state. |

Codex compresses a rollout that has been idle for 7 days into `.jsonl.zst`. It turns the file back into plain `.jsonl` on the next write. Readers must accept both and retry once if the file disappears during a switch. The `threads.rollout_path` column always names the plain `.jsonl` path.

### Rollout records

Every line is `{timestamp, ordinal, type, payload}`. The first line is `session_meta`, which carries `id`, `cwd`, `originator`, `cli_version`, `source`, `git`, and `history_base`. The model is in `turn_context.model`. File names and date folders use local time. Record timestamps use UTC.

- **Client.** `originator` is `codex-tui`, `codex_cli_rs`, `codex_exec`, `Codex Desktop`, or `codex_work_desktop`. `source` is `cli`, `exec`, `vscode`, or a subagent object. The desktop app reports `vscode`.
- **Title.** Use the `session_index.jsonl` name, then the database `title`, then the first user message.

### Resume rules

- `codex resume <id>` and `codex exec resume <id>` find a rollout anywhere under `sessions/`, even with no database row. They then insert the row themselves. Verified.
- `--last` and the picker trust the database. If any thread with a row matches the current folder, a rollout without a row stays invisible. Verified. So import must insert a row whenever `state_5.sqlite` exists.
- A store with no `state_5.sqlite` builds one from every rollout on first run. Verified.
- Resume from a different folder works with the original paths in the rollout. Verified.
- The desktop app syncs its thread list from the same database. Whether it shows an imported row is unverified.

### Import

1. Write the rollout unchanged to `sessions/YYYY/MM/DD/` using the date in its file name, or to `archived_sessions/` for an archived thread.
2. Never rewrite a rollout. Children point into earlier rollouts by byte offset, and an edit breaks them.
3. Insert one `threads` row in a single transaction. Set `rollout_path` to the absolute plain `.jsonl` path and `cwd` to the mapped folder. Set `preview` and `first_user_message` to non-empty values, because the list hides empty previews. Write only columns that `PRAGMA table_info(threads)` reports.
4. Copy `generated_images/<threadId>/` when present.

### Reading a live database

Codex opens its databases in WAL mode and writes them while any Codex process runs. A read-only open fails when the `-wal` and `-shm` files are missing. To read, copy the database with its `-wal` and `-shm` files to a temporary folder and open the copy. To write, open the live database read-write with a busy timeout and keep the transaction short.

## Rules for both agents

- **Never modify a source session during export.** Export reads a snapshot. For an append-only file, it keeps the bytes up to the last newline.
- **Detect sessions in use.** Claude Code lists running sessions in `sessions/<pid>.json`. Check that the process is alive. Codex holds `thread-writer-locks/<threadId>.lock` while it writes. Export of a live session gets a warning. Import into a live session is refused.
- **Conflicts.** For each session, compare the archive copy with the copy already in the target store:
  - No copy: create it.
  - Identical bytes: skip.
  - The existing copy is a strict prefix of the archive copy: update it, and keep the old copy as a backup.
  - Anything else: refuse, and leave both untouched.
- **Private content.** Transcripts hold the account email, account ids, system prompts, and any file or command output that the agent read. Export shows a warning. It does not redact, because redaction would break Codex byte offsets.
- **Untrusted archives.** Import never uses a path from inside an archive as a file path. It checks every blob against its sha256 hash and rejects archives that break the size limits.

## Open questions

- Does the Claude desktop sidebar show an imported transcript that has no `local_*.json`?
- Does the Codex desktop list show an imported row whose `updated_at` is older than its sync watermark?
- Does Codex `--last` match on the database `cwd` or on the rollout's last `turn_context.cwd`?
- How do Windows paths, folder names, and file locks behave? Nothing here has run on Windows or Linux.
- Do subagent resume and `/rewind` work after import?

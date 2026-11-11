---
summary: What it takes to support another coding agent, from the storage research to the provider, the UI entries, and the tests.
read_when:
  - Adding support for another agent
  - Reviewing a pull request that adds an agent
---

# Adding an agent

Most of the work is research, not code. Before you write a provider, find out exactly where the agent keeps a session on disk and what its CLI needs to resume one on another computer. Claude Code needed only its transcript files. Codex also needed rows in its SQLite database. Open an issue with what you found before you start on code, so we can agree the agent fits.

An agent fits when a session is a set of files on the user's computer, and copying those files, with folder paths rewritten, lets the CLI resume it there. Agent Session Mover does not convert sessions between agents, and it does not talk to cloud services.

## 1. Document the storage

Add a section for the agent to [session-storage.md](session-storage.md), like the Claude Code and Codex sections:

- the store folder and the environment variable that moves it;
- each file a session owns, and any database rows or index entries;
- which values hold the project folder, so import can rewrite them;
- what the resume command reads, and which sessions it hides from its picker;
- files that must never leave the computer, such as auth tokens and settings;
- the CLI version you studied.

## 2. Write the provider

Create `src/main/providers/<agent>/` and implement `Provider` from `src/main/core/provider.ts`. The Claude Code provider is the smaller one to copy from. [transfer.md](transfer.md) explains the contract, the archive, and how import plans and rolls back.

- `discover`, `collect`, `inspectTarget`, `findTranscript`, and `previewTranscript` only read.
- `inspectTarget` computes every target path from validated parts. It never uses a path from the archive as is.
- `collect` and `inspectTarget` read whole-store data, such as a folder walk, through `once` (`ImportContext.once` for `inspectTarget`), so an export or preview of many sessions reads the store once.
- Anything that is not a whole file, such as a database row, is a `ProviderEffect`. `undoEffect` must be safe when the effect never ran, ran partly, or is undone twice.

## 3. Register it

Add the agent's id to `AGENT_IDS` in `src/shared/sessions.ts`. TypeScript then reports each table that needs an entry:

- `src/main/providers/registry.ts`, the provider itself;
- `ROLES_BY_AGENT` in `src/main/core/manifest.ts`, the file roles its archive entries may use;
- `AGENT_LABEL` and `PICKER_NOTE` in `src/renderer/src/model/format.ts`, its name and resume picker note.

Add a `.mark-<agent>` style in `src/renderer/src/styles/list.css` for its row mark. Archives that hold the new agent do not open in older versions of the app, which reject an agent they do not know.

## 4. Test it

Follow the Codex tests in `test/`:

- a fixture that builds a realistic store in a temp folder;
- discovery, including sessions it must skip;
- an export and import round trip, an update, a refused conflict, and a live session;
- rollback after a failed write and after a crash, for files and effects.

Then prove a real resume. Add `test/real/<agent>-resume.real.test.ts`, like the Claude Code and Codex ones, so `pnpm verify:real` creates a throwaway session with the real CLI, moves it to another folder, and resumes it. State in the pull request which CLI version and systems you ran it on.

# Agent Sessions

A desktop app that moves Claude Code and Codex sessions from one computer to another. It lists the sessions on this machine, exports the ones you pick into one `.agentsessions` file, and imports that file on another machine so you can resume the sessions there.

A sidebar lists your project folders. Pick one to see only its sessions, or pick All sessions to see every session with its project beside it. Your selection carries across projects, and the sidebar shows how many sessions you picked in each. A session that started subagents shows how many, and the detail panel lists them. They are always exported with their parent. Press `?` for keyboard shortcuts.

The archive holds full transcripts, unredacted: the account email, system prompts, and the contents of every file and command output the agent read. Credentials and settings are never included. After an import, the app reports that the files are in place and shows the resume command. It does not check that the agent opens them.

Built with Electron, React, and TypeScript.

To learn how the pieces fit together, read [How the app works](docs/how-it-works.md). For export and import, read [Moving sessions between machines](docs/transfer.md) and the storage spec in [Session storage and transfer rules](docs/session-storage.md).

## Run

`pnpm dev` runs inside Electron's own app, so the macOS menu bar shows "Electron" there. The packaged app from `pnpm package` shows "Agent Sessions".

Requires Node 24 or newer and pnpm 10. On Node 25 or newer, install pnpm with `npm install -g pnpm@10.13.1`, because Node no longer ships Corepack.

```sh
pnpm install
pnpm dev
```

## Commands

| Command          | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `pnpm dev`       | Starts the app with hot reload.                                  |
| `pnpm build`     | Builds the app into `out/`.                                      |
| `pnpm start`     | Builds the app and runs the build.                               |
| `pnpm typecheck` | Type checks the Node side and the renderer separately.           |
| `pnpm test`      | Runs the unit and behavior tests in `test/` with vitest.         |
| `pnpm package` | Builds `dist/mac-arm64/Agent Sessions.app` (or the Windows or Linux folder on those systems) with the app name and icon. It is not code-signed. |
| `pnpm smoke`     | Builds the app, drives listing progress, refresh, export, and import for Claude Code and Codex on temp stores, and saves screenshots in `artifacts/`. |
| `pnpm screens [prefix]` | Builds the app, opens it on a synthetic store of 52 sessions in 26 folders, and saves each browse state to `artifacts/compare/<prefix>-<state>.png`. The prefix defaults to `after`. It prints how many rows each state shows without scrolling. |
| `pnpm bench:discover` | Builds a synthetic 1.09 GB store once in the temp folder and times listing it cold, after a relaunch, and after one change. `AGENT_SESSIONS_BENCH_REAL=1` also times your real stores, read-only. Results go to `artifacts/bench/`. |
| `pnpm verify:real` | Uses the real `claude` and `codex` CLIs to create a throwaway session, export it, import it under another folder, and resume it. It spends a few model tokens. Claude Code writes to your real store and the test removes what it made. Codex runs in temporary `CODEX_HOME` folders that hold a copy of your `~/.codex/auth.json` for the length of the run. The test refuses to run when the access token expires within 2 hours, so Codex does not refresh the token inside a copy, and it deletes the copies afterwards. |

# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach. The tool stays focused on moving sessions between machines. It does not convert sessions between agents.

## Set up

Requires Node 24 or newer and pnpm 10. On Node 25 or newer, install pnpm with `npm install -g pnpm@10.13.1`, because Node no longer ships Corepack.

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs inside Electron's own app, so the macOS menu bar shows "Electron" there. The packaged app from `pnpm package` shows "Agent Sessions".

## Read first

- [How the app works](docs/how-it-works.md) traces one call from the React page through the preload script to the main process.
- [Moving sessions between machines](docs/transfer.md) covers the archive format, the import executor, and the IPC surface.
- [Session storage and transfer rules](docs/session-storage.md) is the spec for where Claude Code and Codex keep sessions and what a transfer may rewrite.
- [Releasing](docs/RELEASING.md) covers tags, installers, and signing.

## Before you open a pull request

Run `pnpm typecheck`, `pnpm test`, and `pnpm smoke`. CI runs the same three on macOS, Windows, and Linux. For a UI change, attach the screenshots that `pnpm smoke` or `pnpm screens` saves in `artifacts/`. Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope, such as `fix(import): ...`.

## Commands

| Command          | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `pnpm dev`       | Starts the app with hot reload.                                  |
| `pnpm build`     | Builds the app into `out/`.                                      |
| `pnpm start`     | Builds the app and runs the build.                               |
| `pnpm typecheck` | Type checks the Node side and the renderer separately.           |
| `pnpm test`      | Runs the unit and behavior tests in `test/` with vitest.         |
| `pnpm package` | Builds `dist/mac-arm64/Agent Sessions.app` (or the Windows or Linux folder on those systems) with the app name and icon. It is not code-signed. |
| `pnpm dist` | Builds the installers for this OS into `dist/`, named `agent-sessions-<version>-<os>-<arch>`. On a Mac without the signing certificate, run it as `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`. |
| `pnpm smoke`     | Builds the app, drives listing progress, refresh, export, and import for Claude Code and Codex on temp stores, and saves screenshots in `artifacts/`. |
| `pnpm screens [prefix]` | Builds the app, opens it on a synthetic store of 52 sessions in 26 folders, and saves each browse state, an import preview, and an import that replaces a file to `artifacts/compare/<prefix>-<state>.png`. The prefix defaults to `after`. It prints how many rows each state shows without scrolling. |
| `pnpm bench:discover` | Builds a synthetic 1.09 GB store once in the temp folder and times listing it cold, after a relaunch, and after one change. `AGENT_SESSIONS_BENCH_REAL=1` also times your real stores, read-only. Results go to `artifacts/bench/`. |
| `pnpm verify:real` | Uses the real `claude` and `codex` CLIs to create a throwaway session, export it, import it under another folder, and resume it. It spends a few model tokens. Claude Code writes to your real store and the test removes what it made. Codex runs in temporary `CODEX_HOME` folders that hold a copy of your `~/.codex/auth.json` for the length of the run. The test refuses to run when the access token expires within 2 hours, so Codex does not refresh the token inside a copy, and it deletes the copies afterwards. |

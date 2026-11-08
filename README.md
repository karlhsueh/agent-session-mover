# Agent Sessions

A desktop app that moves Claude Code sessions from one computer to another. It lists the sessions on this machine, exports the ones you pick into one `.agentsessions` file, and imports that file on another machine so you can resume the sessions there. Codex support is in progress.

The archive holds full transcripts, unredacted: the account email, system prompts, and the contents of every file and command output the agent read. Credentials and settings are never included. After an import, the app reports that the files are in place and shows the resume command. It does not check that the agent opens them.

Built with Electron, React, and TypeScript.

To learn how the pieces fit together, read [How the app works](docs/how-it-works.md). For export and import, read [Moving sessions between machines](docs/transfer.md) and the storage spec in [Session storage and transfer rules](docs/session-storage.md).

## Run

Requires Node 24.

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
| `pnpm smoke`     | Builds the app, drives export and import on temp stores, and saves screenshots in `artifacts/`. |

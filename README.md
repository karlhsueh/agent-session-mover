# Agent Sessions

A hello world desktop app built with Electron, React, and TypeScript. The renderer sends a name to the main process over IPC, and the page shows the reply.

To learn how the pieces fit together, read [How the app works](docs/how-it-works.md).

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
| `pnpm smoke`     | Builds the app, tests it, and saves screenshots in `artifacts/`. |

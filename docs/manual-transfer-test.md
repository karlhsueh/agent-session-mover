---
summary: Step-by-step test that moves sessions to a second computer and checks which clients can resume them.
read_when:
  - Testing a transfer between two real machines
  - Checking whether a client lists imported sessions
---

# Test a transfer between two machines

In this test, you move a few sessions from machine A to machine B and check which clients can resume them on B. Both machines in these steps are Macs. Windows and Linux have not been tested.

## Before you start

On both machines:

- Install Claude Code and Codex, and sign in to each. Run `claude` and `codex` once to confirm.
- Choose a test project folder that exists on both machines, for example `~/Code/transfer-test`. The full path can differ between the machines.

## 1. Make test sessions on machine A

Fresh sessions with a code word let you prove a resume without reading private history.

1. Run `mkdir -p ~/Code/transfer-test && cd ~/Code/transfer-test`.
2. Run `claude` (interactive, not `-p`). Type `Remember the code word MANGO. Reply OK.` and then exit.
3. Run `codex` (interactive, not `codex exec`). Type `Remember the code word PAPAYA. Reply OK.` and then exit.
4. Optional: ask Codex for a task that spawns a subagent, so the session shows a `+N` badge.
5. Optional: include one real session that you want on machine B.

## 2. Export on machine A

1. In the app, click the `transfer-test` project in the sidebar.
2. Press Cmd+A, then click **Export**. Read the warning, then save the archive.
3. Copy the `.agentsessions` file to machine B with AirDrop, a USB drive, or a shared folder.

## 3. Install and run the app on machine B

1. Check Node with `node -v`. Version 24 or newer works; 26.13 is tested. If Node is missing or older, run `brew install node@24` and follow the printed `PATH` instructions.
2. Install pnpm:
   - On Node 25 or newer, run `npm install -g pnpm@10.13.1`. Node 25 stopped shipping Corepack.
   - On Node 24, `corepack enable` also works.
3. Get the code. The repository is private, so sign in to GitHub first:
   - Run `brew install gh && gh auth login`, then `gh repo clone karlhsueh/agent-sessions ~/Code/agent-sessions`.
   - Without GitHub access, copy `agent-sessions.bundle` from machine A and run `git clone ~/Downloads/agent-sessions.bundle ~/Code/agent-sessions`.
   - To get a fix later, run `git pull` in `~/Code/agent-sessions`, then `pnpm install`.
4. Install: `cd ~/Code/agent-sessions && pnpm install`.
5. Start: `pnpm dev`. `pnpm install` downloads Electron, which is about 100 MB, so machine B needs internet access. If `pnpm dev` reports `Error: Electron uninstall`, run `node node_modules/electron/install.js` and start again.

## 4. Import on machine B

1. Quit the Claude desktop app and the Codex desktop app, so they reload their lists after the import.
2. Make the test folder: `mkdir -p ~/Code/transfer-test`.
3. In the app, click **Import** and open the archive.
4. In **Folders**, set the target for `transfer-test` to `~/Code/transfer-test` on machine B. The status must say **Folder exists**.
5. Check that each session says **Create**. Click **Preview** on one to see the conversation.
6. Click **Import**. Each session must say **Placed**.

## 5. Check each client

Run every check in `~/Code/transfer-test` on machine B. Record pass or fail for each row. In the table, "the word" means MANGO for Claude Code and PAPAYA for Codex.

| # | Client | Do this | Pass when |
| --- | --- | --- | --- |
| 1 | Claude Code CLI | `claude --resume <id>`, then ask `What was the code word?` | It answers MANGO. |
| 2 | Claude Code CLI | `claude --continue`, then ask the same question | It answers MANGO. |
| 3 | Claude Code CLI | `claude`, then type `/resume` | The session is in the list. |
| 4 | Claude desktop, Code tab | Open the app | The session is in the sidebar or in `/resume`. |
| 5 | VS Code extension | Open the folder in VS Code and open past conversations | The session is listed. |
| 6 | Codex CLI | `codex resume <id>`, then ask `What was the code word?` | It answers PAPAYA. |
| 7 | Codex CLI | `codex resume` (the picker) | The session is listed. |
| 8 | Codex CLI | `codex resume --last` | It opens the PAPAYA session. |
| 9 | Codex desktop app | Open the app | The thread is listed. |
| 10 | Subagents (if step 1.4 was done) | Resume the parent and ask what its subagent did | It describes the subagent's work. |

Copy each `<id>` from the app's detail panel. The **Copy** button next to the resume command copies the full command.

## 6. Optional: send it back

1. On machine B, continue one session for one more turn.
2. Export it on machine B and import it on machine A.
3. The preview must say **Update**. After the import, the session on machine A must have the new turn.

## Report the results

Send the table with pass or fail for each row. For a failure, add the session id, the client, the exact command, and a screenshot of what the client showed. Do not send transcript contents.

## Undo the test

- Claude Code: move `~/.claude/projects/<folder>/<id>.jsonl` and the `<id>` folder next to it to the Trash. The app's detail panel shows the folder.
- Codex: run `codex delete <id>`.
- Backups of any updated sessions are in `~/Library/Application Support/agent-sessions/backups/`.

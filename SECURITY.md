# Security

## What an archive contains

A `.agentsessions` archive holds full session transcripts, unredacted. That includes the account email and ids recorded in a session, system prompts, every message, and the contents of files and command output the agent read. It also names the computer it came from and, for each project folder in a repository, one remote address. Treat an archive like the source code and secrets it may quote. Send it over a channel you trust and delete it when the move is done.

Agent Session Mover never puts credentials, auth tokens, settings, or prompt history into an archive. A remote address is read from the repository config file without running anything, and the user name and password of an http or https address are removed before it is written. Nothing else in that config file is recorded. Import rejects an archive whose remote address carries a user name or password, or any character a shell or option parser would act on.

## What import trusts

Import treats every archive as untrusted input. It checks the manifest version and the SHA-256 of every file, rejects paths that would land outside the agent's store, caps sizes, and writes nothing until you start the import. An import that fails partway rolls back, and an update keeps a backup of the copy it replaced. [Moving sessions between machines](docs/transfer.md) has the details.

The app sends nothing about your sessions over the network. Its only request is the check for a new version, which reads the release metadata on GitHub. It downloads and installs an update only when you click to.

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/karlhsueh/agent-session-mover/security/advisories/new) rather than in a public issue. Include the app version, your OS, and steps or an archive that reproduces the problem.

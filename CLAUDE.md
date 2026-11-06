# cello (repo: cello-v2)

The CELLO client: daemon, commands and Claude Code tools. The design is in the spec in `trustless-cello/docs/planning/rewrite/SPEC-v2.0.md`, and the current scope is in `BUILD-PLAN.md` beside it. The server is in the separate `cello-server` repo.

## How work runs

A unit of work is: build a bit, run `cello-unit-reviewer` on it, fix what it finds. Then start the next.

Tests: the main tests are live ones with real processes. Write a small test only where a mistake wouldn't show by itself, such as crypto, chain checks and tampering. No fixed order. When a test catches a real bug, say so in the commit message.

Old code is reference. Copy only what the current work needs, works without the old structure, and would be written the same way today. Copy by script, strip its history, and add it to `COPIED.md`.

## Rules

- **Everything is a CLI command, and MCP is a shim on top.** Every operation goes in `src/ipc/operations.ts`, which builds both. MCP adds only what a shell can't do: the wake.
- **Identity and state never live in a connection.** Every call names its agent and caller. The holder is a caller, not a socket. A read counts only after the reply is written.
- Comments say what's not obvious, in a line or two. History belongs in commit messages.
- Everything signed gets both signatures, Ed25519 and ML-DSA-44, and both must verify.
- Signed bytes come only from `src/protocol/structures.ts`, and `signal.ts` and `issuer-list.ts` beside it for trust signals and the issuer list.
- Tables key on the agent's id, never its name. SQLCipher only: `node:sqlite` is banned.
- No mocks in production code, and no silent fallbacks: fail by name.
- Every wait has an end, and every failure names its cause to the person affected.
- Commit by explicit path, and push every commit.

A git hook runs `pnpm run check` before each commit. How the live tests run, and when, is in `live/README.md`.

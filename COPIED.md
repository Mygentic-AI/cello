# What was copied, and why

Everything else in this repo was written new. Source repo: `cello-client`, branch `claude/m9d-post-quantum-safe-362g09`, commit `11e75b40`.

Each file was copied by script, with comments on their own lines removed and long error messages shortened. Conditions and logic are unchanged except as noted.

One change applies to both post-quantum key files: they now get the public key through `subtle.getPublicKey`, because the original route is deprecated in Node and printed a warning.

- `src/protocol/ml-dsa.ts`, from `core/crypto/src/ml-dsa.ts`. Post-quantum signing on Node's own crypto.
- `src/protocol/ml-kem.ts`, from `core/crypto/src/ml-kem.ts`. Post-quantum key exchange on Node's own crypto.
- `src/protocol/pq-errors.ts`, `src/protocol/pq-warnings.ts`, same names. The errors the two above throw, and a filter for Node's warnings about them.
- `src/protocol/key-agreement.ts`, from `core/crypto/src/session-key-agreement.ts`. The hybrid session key. Its label changed to `cello-session-content-key`.
- `src/protocol/salt.ts`, from `core/crypto/src/session-salt.ts`. The salt both sides contribute to. Its label changed to `cello-session-salt`, and the unused fingerprint was removed.
- `src/protocol/aead.ts`, from `core/crypto/src/session-content-seal.ts`. AES-256-GCM for message text.
- `test/vectors/acvp-975de31e/`, the official NIST vectors, with their source note. `test/vectors.test.ts` is a rewrite of the harness in `ml-dsa.test.ts` and `ml-kem.test.ts`.

`src/protocol/identity.ts` is new, with its signing frame taken from `core/crypto/src/pq-frame.ts`.

## Governance

From `cello-client`, comments on their own lines removed, ids changed to blobs, the database and log calls changed to this client's. Channel scopes wait for the channels merge, and the limits they held as constants now come from the database.

- `src/daemon/policy-store.ts`, `policy-proposals.ts`, from `core/daemon/src/`, same names. Written policies, and the agent-proposes, person-approves flow.
- `src/daemon/policy-cadence.ts`, from `core/daemon/src/`, same name, without the channel half.
- `src/daemon/pii.ts`, `rate-limit.ts`, from `core/gateway/src/detect/`, same names. Its text now names this client's command.
- `src/daemon/who-label.ts`, from `core/daemon/src/who-label.ts` and `core/protocol-types/src/moniker.ts`: only the name rule and the short form of a key. The choosing of a label is in `contacts.ts`, since v2 marks a self-declared name.
- `src/daemon/guards.ts` is a rewrite, with the classifiers, baselines and refusal texts of `core/gateway/src/config/config-store.ts` and `core/daemon/src/gateway-config-handlers.ts`. It keeps a plain log instead of v1's hash chain.
- `src/daemon/reach.ts` and `tiers.ts` are rewrites, with the numbers and refusal texts of `core/daemon/src/contacts-tier-migration.ts` and `agent-settings-keys.ts`.

## The screener

From `cello-client`, `core/gateway/src/detect/`, commit `2ea5834d`: comments on their own lines removed, imports rewritten. Each works alone and would be written the same way today. Nothing from the gateway's socket client or its deadline logic came across.

- `src/screener/sanitize.ts`, `scan-variants.ts`, `injection-patterns.ts`, `language.ts`, same names. The deterministic inbound screen.
- `src/screener/secrets.ts`, `gitleaks-rules.ts`, `exfil.ts`, same names. The outbound screen's detectors.
- `src/screener/linear-regex.ts`, same name. Native RE2 was removed, because it compiles from source on every install, and WASM gives the same guarantee.
- `src/screener/injection-windows.ts`, `classifier-selfcheck.ts`, `screener-model-manifest.ts`, `model-installer.ts`, same names, as they were.
- `src/screener/injection-classifier-onnx.ts`, `injection-classifier-wasm.ts`, same names. Each also offers one window at a time, so a screen can stop between windows. The native one sets four threads and no idle spinning.
- `src/screener/screener-state.ts`, same name. Its paths now live under this client's home.

`src/screener/inbound.ts` and `outbound.ts` are rewrites of `screen/inbound.ts` and `screen/outbound.ts`, with the same checks, as steps a scheduler can pause. Left out, by the copying test, because they need things v2 doesn't have yet: the outbound rate limiter and the personal-data warnings, which need a decision-and-resend flow.

## The CBOR encoder

- `src/protocol/cbor.ts`, from `cello-client/core/protocol-types/src/cbor.ts`, unchanged and comments kept, because they state the rules. cbor-x is held at exactly 1.6.4, the version it was measured on, because signed bytes depend on it.
- `test/no-multiple-cbor-encoders.test.ts` is a port of the test of the same name in `core/protocol-types`, from vitest to node:test.

## Guidance

`src/guidance.ts`: sentences from `cello-client`, commit `2ea5834d`, changed only where a name or command no longer exists. From `core/daemon/src/session-content-handlers.ts`, `close-session-handler.ts`, `session-read-handlers.ts`, `session-closed.ts`, `session-liveness.ts`, `agent-handlers.ts`, `frontier-mismatch.ts`, and `core/adapter-claude-code/src/signal-guidance.ts`, `channel-params.ts`, `cello-tools.ts`.

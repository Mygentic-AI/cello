# What was copied, and why

Everything else in this repo was written new. Source repo: `cello-client`, branch `claude/m9d-post-quantum-safe-362g09`, commit `11e75b40`.

Each file was copied by script, with comments on their own lines removed and long error messages shortened. Conditions and logic are unchanged except as noted.

One change applies to both post-quantum key files: they now get the public key through `subtle.getPublicKey`, because the original route is deprecated in Node and printed a warning.

- `src/protocol/ml-dsa.ts`, from `core/crypto/src/ml-dsa.ts`. Post-quantum signing on Node's own crypto.
- `src/protocol/ml-kem.ts`, from `core/crypto/src/ml-kem.ts`. Post-quantum key exchange on Node's own crypto.
- `src/protocol/pq-errors.ts`, `src/protocol/pq-warnings.ts`, same names. The errors the two above throw, and a filter for Node's warnings about them.
- `src/protocol/key-agreement.ts`, from `core/crypto/src/session-key-agreement.ts`. The hybrid session key. Its label changed to `cello-v2/session/content-key`.
- `src/protocol/salt.ts`, from `core/crypto/src/session-salt.ts`. The salt both sides contribute to. Its label changed to `cello-v2/session/salt`, and the unused fingerprint was removed.
- `src/protocol/aead.ts`, from `core/crypto/src/session-content-seal.ts`. AES-256-GCM for message text.
- `test/vectors/acvp-975de31e/`, the official NIST vectors, with their source note. `test/vectors.test.ts` is a rewrite of the harness in `ml-dsa.test.ts` and `ml-kem.test.ts`.

`src/protocol/identity.ts` is new, with its signing frame taken from `core/crypto/src/pq-frame.ts`.

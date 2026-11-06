// The public halves of the three root keys, shipped in the client. Made on 6 November 2026: enclave on Andre's Mac,
// KMS in cello-infra (keyring cello-root, key issuer-list-root, version 1, HSM), paper sealed with Andre's passphrase.
import { type RootAlgorithm, type RootKey, type RootName, rootKeysFrom } from "./issuer-list.ts";

const hex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));

export const PRODUCTION_ROOT_KEYS: Readonly<Record<RootName, { algorithm: RootAlgorithm; publicKey: Uint8Array } | null>> = {
  enclave: { algorithm: "p256", publicKey: hex("04cc234a1b150da2ba91b6dde521a6fd1c54a0dfb64a6bcb471b2260934d8354e61d6a0fcc03a694c8c53bc88bc3da5b90280baee89072ab6f4c2371f466c5b81f") },
  kms: { algorithm: "p256", publicKey: hex("0412ca53dc2d3087e3f369e0bbeb38e036558de41ffaf3df75405663f81b56b60582c76baeb575123ae9e5b1195311a43f4ad5dc5bbed5d4be60c175a54283e6a3") },
  paper: { algorithm: "ed25519", publicKey: hex("7d05ff4e73879c4e1b7bb4a84f381c1aa4f7c550d6088004484c773efad3f5cc") },
};

export const productionRootKeys = (): readonly RootKey[] => rootKeysFrom(PRODUCTION_ROOT_KEYS);

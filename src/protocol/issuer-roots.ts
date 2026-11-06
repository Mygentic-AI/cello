// The public halves of the three root keys, shipped in the client. Creating them is Andre's, so until then nothing can be trusted, by name.
import { type RootAlgorithm, type RootKey, type RootName, rootKeysFrom } from "./issuer-list.ts";

export const PRODUCTION_ROOT_KEYS: Readonly<Record<RootName, { algorithm: RootAlgorithm; publicKey: Uint8Array } | null>> = {
  enclave: null,
  kms: null,
  paper: null,
};

export const productionRootKeys = (): readonly RootKey[] => rootKeysFrom(PRODUCTION_ROOT_KEYS);

import "./pq-warnings.ts";
import { createPublicKey, KeyObject, webcrypto } from "node:crypto";
import { PqCryptoError, isUnsupportedAlgorithm } from "./pq-errors.ts";

export const ML_KEM_PUBLIC_KEY_BYTES = 1184;
export const ML_KEM_CIPHERTEXT_BYTES = 1088;
export const ML_KEM_SEED_BYTES = 64;
export const ML_KEM_SHARED_SECRET_BYTES = 32;

const ALG = { name: "ML-KEM-768" } as const;
const subtle = webcrypto.subtle;

interface PqSubtle {
  importKey(format: "raw-seed" | "raw-public", keyData: Uint8Array, algorithm: typeof ALG, extractable: boolean, usages: string[]): Promise<webcrypto.CryptoKey>;
  encapsulateBits(algorithm: typeof ALG, key: webcrypto.CryptoKey): Promise<{ ciphertext: ArrayBuffer; sharedKey: ArrayBuffer }>;
  decapsulateBits(algorithm: typeof ALG, key: webcrypto.CryptoKey, ciphertext: Uint8Array): Promise<ArrayBuffer>;
}
const pq = subtle as unknown as PqSubtle;

function unsupported(err: unknown): PqCryptoError {
  return new PqCryptoError(
    "pq_runtime_unsupported",
    `ML-KEM-768 is not available in this Node (${process.version}); CELLO needs Node >= 24.7`,
    { cause: err },
  );
}

async function importSeed(seed: Uint8Array): Promise<webcrypto.CryptoKey> {
  if (!(seed instanceof Uint8Array) || seed.length !== ML_KEM_SEED_BYTES) {
    throw new PqCryptoError("ml_kem_seed_invalid", `ML-KEM-768 seed must be ${ML_KEM_SEED_BYTES} bytes, got ${seed?.length}`);
  }
  try {
    return await pq.importKey("raw-seed", seed, ALG, false, ["decapsulateBits"]);
  } catch (err) {
    if (isUnsupportedAlgorithm(err)) throw unsupported(err);
    throw new PqCryptoError("ml_kem_seed_invalid", "ML-KEM-768 seed import failed", { cause: err });
  }
}

export function mlKemGenerateSeed(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(ML_KEM_SEED_BYTES));
}

export async function mlKemKeypairFromSeed(seed: Uint8Array): Promise<{ publicKey: Uint8Array }> {
  const key = await importSeed(seed);
  const pub = createPublicKey(KeyObject.from(key)).export({ format: "raw-public" } as never) as unknown as Buffer;
  return { publicKey: new Uint8Array(pub) };
}

export async function mlKemEncapsulate(publicKey: Uint8Array): Promise<{ ciphertext: Uint8Array; sharedSecret: Uint8Array }> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ML_KEM_PUBLIC_KEY_BYTES) {
    throw new PqCryptoError("ml_kem_public_key_invalid", `ML-KEM-768 public key must be ${ML_KEM_PUBLIC_KEY_BYTES} bytes, got ${publicKey?.length}`);
  }
  let key: webcrypto.CryptoKey;
  try {
    key = await pq.importKey("raw-public", publicKey, ALG, true, ["encapsulateBits"]);
  } catch (err) {
    if (isUnsupportedAlgorithm(err)) throw unsupported(err);
    throw new PqCryptoError("ml_kem_public_key_invalid", "ML-KEM-768 public key failed the FIPS 203 encapsulation-key check", { cause: err });
  }
  const { ciphertext, sharedKey } = await pq.encapsulateBits(ALG, key);
  return { ciphertext: new Uint8Array(ciphertext), sharedSecret: new Uint8Array(sharedKey) };
}

export async function mlKemDecapsulate(seed: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await importSeed(seed);
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length !== ML_KEM_CIPHERTEXT_BYTES) {
    throw new PqCryptoError("ml_kem_ciphertext_invalid", `ML-KEM-768 ciphertext must be ${ML_KEM_CIPHERTEXT_BYTES} bytes, got ${ciphertext?.length}`);
  }
  return new Uint8Array(await pq.decapsulateBits(ALG, key, ciphertext));
}

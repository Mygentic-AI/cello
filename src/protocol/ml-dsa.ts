import "./pq-warnings.ts";
import { webcrypto } from "node:crypto";
import { PqCryptoError, isUnsupportedAlgorithm } from "./pq-errors.ts";

export const ML_DSA_PUBLIC_KEY_BYTES = 1312;
export const ML_DSA_SIGNATURE_BYTES = 2420;
export const ML_DSA_SEED_BYTES = 32;

export type MlDsaPublicKey = Uint8Array;

export type MlDsaSignature = Uint8Array;

export interface MlDsaKeyProvider {
  getPublicKey(): Promise<MlDsaPublicKey>;
  sign(message: Uint8Array): Promise<MlDsaSignature>;
}

export const ML_DSA_ALGORITHM_LABEL = "ML-DSA-44";

export const ML_DSA_ALGORITHM = { name: ML_DSA_ALGORITHM_LABEL } as const;

function mlDsaUnsupported(err: unknown): PqCryptoError {
  return new PqCryptoError(
    "pq_runtime_unsupported",
    `ML-DSA-44 is not available in this Node (${process.version}); CELLO needs Node >= 24.7`,
    { cause: err },
  );
}

// @types/node doesn't type getPublicKey yet. Node 24.7+ implements it.
interface PublicKeySubtle {
  getPublicKey(key: webcrypto.CryptoKey, usages: string[]): Promise<webcrypto.CryptoKey>;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class InMemoryMlDsaKeyProvider implements MlDsaKeyProvider {
  readonly #key: webcrypto.CryptoKey;
  readonly #publicKey: MlDsaPublicKey;

  private constructor(key: webcrypto.CryptoKey, publicKey: Uint8Array) {
    this.#key = key;
    this.#publicKey = publicKey;
  }

  static async fromSeed(seed: Uint8Array): Promise<InMemoryMlDsaKeyProvider> {
    if (!(seed instanceof Uint8Array) || seed.length !== ML_DSA_SEED_BYTES) {
      throw new PqCryptoError("ml_dsa_seed_invalid", `ML-DSA-44 seed must be ${ML_DSA_SEED_BYTES} bytes, got ${seed?.length}`);
    }
    let key: webcrypto.CryptoKey;
    try {
      key = await webcrypto.subtle.importKey("raw-seed", new Uint8Array(seed), ML_DSA_ALGORITHM, false, ["sign"]);
    } catch (err) {
      if (isUnsupportedAlgorithm(err)) throw mlDsaUnsupported(err);
      throw new PqCryptoError("ml_dsa_seed_invalid", "ML-DSA-44 seed import failed", { cause: err });
    }
    const publicKey = await (webcrypto.subtle as unknown as PublicKeySubtle).getPublicKey(key, ["verify"]);
    const pub = await webcrypto.subtle.exportKey("raw-public" as never, publicKey);
    return new InMemoryMlDsaKeyProvider(key, new Uint8Array(pub as ArrayBuffer));
  }

  async getPublicKey(): Promise<MlDsaPublicKey> {
    return this.#publicKey.slice();
  }

  async sign(message: Uint8Array): Promise<MlDsaSignature> {
    return new Uint8Array(await webcrypto.subtle.sign(ML_DSA_ALGORITHM, this.#key, new Uint8Array(message)));
  }

  toJSON(): Record<string, string> {
    return { type: "InMemoryMlDsaKeyProvider", publicKey: Buffer.from(this.#publicKey).toString("hex") };
  }

  toString(): string {
    return `InMemoryMlDsaKeyProvider(pubkey=${Buffer.from(this.#publicKey).toString("hex")})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

export function mlDsaGenerateSeed(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(ML_DSA_SEED_BYTES));
}

export async function mlDsaProviderFromSeed(seed: Uint8Array): Promise<MlDsaKeyProvider> {
  return InMemoryMlDsaKeyProvider.fromSeed(seed);
}

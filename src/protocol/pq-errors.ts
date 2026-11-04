export const PQ_CRYPTO_ERROR_REASONS = [
  "ml_kem_seed_invalid",
  "ml_kem_public_key_invalid",
  "ml_kem_ciphertext_invalid",
  "ml_dsa_seed_invalid",
  "pq_context_unknown",
  "pq_runtime_unsupported",
] as const;

export type PqCryptoErrorReason = (typeof PQ_CRYPTO_ERROR_REASONS)[number];

export class PqCryptoError extends Error {
  readonly reason: PqCryptoErrorReason;

  constructor(reason: PqCryptoErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PqCryptoError";
    this.reason = reason;
  }
}

export function isUnsupportedAlgorithm(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "NotSupportedError") return true;
  return (err as { code?: unknown }).code === "ERR_INVALID_ARG_VALUE" && /type (KeyFormat|Algorithm)/.test(err.message);
}

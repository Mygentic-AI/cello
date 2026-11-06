// The KMS root key: P-256 in Google Cloud KMS hardware (cello-infra, us-east1, keyring cello-root, key issuer-list-root).
// KMS hardware can't do Ed25519, and P-256 is an allowed root algorithm. The key can't be exported.
//
//   node tools/root-keys/kms.ts public   prints the public key (65 bytes uncompressed, hex)
//   node tools/root-keys/kms.ts sign     signs stdin, prints r||s (64 bytes, hex): ECDSA P-256 over SHA-256 of the message
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = ["--key", "issuer-list-root", "--keyring", "cello-root", "--location", "us-east1", "--project", "cello-infra", "--version", "1"];
const gcloud = (args: string[]) => execFileSync("gcloud", args, { stdio: ["ignore", "pipe", "inherit"] });

// A DER ECDSA signature is SEQUENCE { INTEGER r, INTEGER s }. Each integer is padded or trimmed to 32 bytes.
function derToRaw(der: Buffer): Buffer {
  let at = 2;
  if (der[0] !== 0x30) throw new Error("KMS returned a signature that isn't DER");
  if (der[1]! & 0x80) at += der[1]! & 0x7f;
  const part = () => {
    if (der[at] !== 0x02) throw new Error("KMS returned a malformed DER integer");
    const length = der[at + 1]!;
    const value = der.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    const trimmed = value.subarray(Math.max(0, value.length - 32));
    if (value.length > 33 || value.subarray(0, value.length - trimmed.length).some((byte) => byte !== 0)) throw new Error("KMS returned an integer longer than 32 bytes");
    return Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]);
  };
  return Buffer.concat([part(), part()]);
}

const command = process.argv[2];
if (command === "public") {
  const pem = gcloud(["kms", "keys", "versions", "get-public-key", ...KEY.slice(-1), ...KEY.slice(0, -2)]).toString("utf8");
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  process.stdout.write(`${point.toString("hex")}\n`);
} else if (command === "sign") {
  const folder = mkdtempSync(join(tmpdir(), "cello-kms-"));
  try {
    const input = join(folder, "message");
    const signature = join(folder, "signature");
    // gcloud hashes the file itself with --digest-algorithm, so it gets the message, not a digest.
    writeFileSync(input, readFileSync(0));
    gcloud(["kms", "asymmetric-sign", ...KEY, "--digest-algorithm", "sha256", "--input-file", input, "--signature-file", signature]);
    process.stdout.write(`${derToRaw(readFileSync(signature)).toString("hex")}\n`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
} else {
  process.stderr.write("usage: kms.ts public|sign\n");
  process.exit(1);
}

// The paper root key: an Ed25519 key whose 32-byte seed is sealed with a passphrase and printed.
// The passphrase is read from the terminal only, never from an argument, a pipe or the environment.
// Sealing: scrypt (N=2^17, r=8, p=1) makes a 32-byte key from the passphrase and a random 16-byte salt,
// then AES-256-GCM seals the seed under a random 12-byte nonce. A wrong passphrase or a mistyped line fails the GCM check.
//
//   node tools/root-keys/paper.ts create <sheet-file>   makes the key, writes the sheet to print, prints the public key
//   node tools/root-keys/paper.ts sign <sheet-file>     asks for the passphrase, signs stdin, prints the 64-byte signature in hex
import { ed25519 } from "@noble/curves/ed25519.js";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function fail(message: string): never {
  process.stderr.write(`paper: ${message}\n`);
  process.exit(1);
}

// Reads a line from the terminal with echo off. Refuses when there's no terminal, so nothing can pipe a passphrase in.
function askHidden(prompt: string): string {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return fail("this needs a terminal to ask for the passphrase");
  }
  writeSync(fd, prompt);
  execFileSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] });
  let line = "";
  try {
    const one = Buffer.alloc(1);
    while (readSync(fd, one, 0, 1, null) === 1 && one[0] !== 0x0a) line += one.toString("utf8");
  } finally {
    execFileSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] });
    writeSync(fd, "\n");
    closeSync(fd);
  }
  return line;
}

const groups = (hex: string) => hex.match(/.{1,4}/g)!.join(" ");
const field = (sheet: string, name: string) => {
  const line = sheet.split("\n").find((entry) => entry.toLowerCase().startsWith(`${name}:`));
  if (!line) return fail(`the sheet has no "${name}:" line`);
  return Buffer.from(line.slice(name.length + 1).replace(/\s+/g, ""), "hex");
};

const [command, pathArg] = process.argv.slice(2);
const path = pathArg ?? fail("usage: paper.ts create|sign <sheet-file>");
if ( (command !== "create" && command !== "sign")) fail("usage: paper.ts create|sign <sheet-file>");

if (command === "create") {
  if (existsSync(path)) fail(`${path} already exists. Nothing was changed.`);
  const passphrase = askHidden("Passphrase (at least 5 words or 20 characters): ");
  if (passphrase.length < 20) fail("that passphrase is too short. Nothing was made.");
  if (askHidden("Again: ") !== passphrase) fail("the two didn't match. Nothing was made.");
  const seed = randomBytes(32);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), nonce);
  const sealed = Buffer.concat([cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
  const publicKey = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
  seed.fill(0);
  const sheet = [
    "CELLO paper root key. Keep this sheet and the passphrase in different places.",
    "Sealed with scrypt N=2^17 r=8 p=1 and AES-256-GCM. To sign: node tools/root-keys/paper.ts sign <this file>",
    "",
    `public: ${groups(publicKey)}`,
    `salt:   ${groups(salt.toString("hex"))}`,
    `nonce:  ${groups(nonce.toString("hex"))}`,
    `sealed: ${groups(sealed.toString("hex"))}`,
    "",
  ].join("\n");
  writeFileSync(path, sheet, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${publicKey}\n`);
} else {
  const sheet = readFileSync(path, "utf8");
  const sealed = field(sheet, "sealed");
  if (sealed.length !== 48) fail("the sealed line should be 96 hex characters");
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(askHidden("Passphrase: "), field(sheet, "salt"), 32, SCRYPT), field(sheet, "nonce"));
  decipher.setAuthTag(sealed.subarray(32));
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(sealed.subarray(0, 32)), decipher.final()]);
  } catch {
    seed = fail("wrong passphrase, or a line on the sheet was mistyped");
  }
  const publicKey = Buffer.from(ed25519.getPublicKey(seed));
  if (!publicKey.equals(field(sheet, "public"))) fail("the key doesn't match the sheet's public line");
  const message = readFileSync(0);
  process.stdout.write(`${Buffer.from(ed25519.sign(message, seed)).toString("hex")}\n`);
  seed.fill(0);
}

// A running Merkle root over a session's entries, with RFC 6962 hashing.
// It keeps only the tree's peaks, so a server can extend it without reading the whole log.
import { sha256 } from "@noble/hashes/sha2.js";
import { HASH_BYTES, exact } from "./encode.ts";

export const EMPTY_ROOT: Uint8Array = sha256(new Uint8Array(0));

export function leafHash(entryHash: Uint8Array): Uint8Array {
  exact("entry hash", entryHash, HASH_BYTES);
  const buf = new Uint8Array(1 + HASH_BYTES);
  buf[0] = 0x00;
  buf.set(entryHash, 1);
  return sha256(buf);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + HASH_BYTES * 2);
  buf[0] = 0x01;
  buf.set(left, 1);
  buf.set(right, 1 + HASH_BYTES);
  return sha256(buf);
}

export class RunningMerkle {
  #size: number;
  #peaks: Uint8Array[];

  constructor(size = 0, peaks: Uint8Array[] = []) {
    let bits = 0;
    for (let n = size; n > 0; n = Math.floor(n / 2)) bits += n % 2;
    if (!Number.isSafeInteger(size) || size < 0 || peaks.length !== bits) {
      throw new RangeError(`a tree of size ${size} has ${bits} peaks, got ${peaks.length}`);
    }
    this.#size = size;
    this.#peaks = peaks.slice();
  }

  static fromBytes(size: number, bytes: Uint8Array): RunningMerkle {
    if (bytes.length % HASH_BYTES !== 0) throw new RangeError(`peaks must be multiples of ${HASH_BYTES} bytes`);
    const peaks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += HASH_BYTES) peaks.push(bytes.slice(at, at + HASH_BYTES));
    return new RunningMerkle(size, peaks);
  }

  get size(): number {
    return this.#size;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#peaks.length * HASH_BYTES);
    this.#peaks.forEach((peak, i) => out.set(peak, i * HASH_BYTES));
    return out;
  }

  append(entryHash: Uint8Array): Uint8Array {
    let hash = leafHash(entryHash);
    for (let n = this.#size; n % 2 === 1; n = Math.floor(n / 2)) {
      hash = nodeHash(this.#peaks.pop() as Uint8Array, hash);
    }
    this.#peaks.push(hash);
    this.#size += 1;
    return this.root();
  }

  root(): Uint8Array {
    if (this.#peaks.length === 0) return EMPTY_ROOT;
    let root = this.#peaks[this.#peaks.length - 1] as Uint8Array;
    for (let i = this.#peaks.length - 2; i >= 0; i--) root = nodeHash(this.#peaks[i] as Uint8Array, root);
    return root;
  }
}

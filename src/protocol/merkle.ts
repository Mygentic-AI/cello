// A running Merkle root over a session's entries, with RFC 6962 hashing.
// It keeps only the tree's peaks, so a server can extend it without reading the whole log.
import { sha256 } from "@noble/hashes/sha2.js";
import { HASH_BYTES, equalBytes, exact } from "./encode.ts";

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

  // The proof that a leaf appended now sits in the tree: the peaks, smallest first.
  nextLeafPath(): Uint8Array[] {
    return this.#peaks.slice().reverse();
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

// A proof longer than this can't belong to any tree this code can count, so it's refused unread.
const MAX_PROOF_HASHES = 106;

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function subtreeRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(subtreeRoot(leaves.slice(0, k)), subtreeRoot(leaves.slice(k)));
}

function subproof(m: number, leaves: readonly Uint8Array[], whole: boolean): Uint8Array[] {
  if (m === leaves.length) return whole ? [] : [subtreeRoot(leaves)];
  const k = largestPowerOfTwoBelow(leaves.length);
  if (m <= k) return [...subproof(m, leaves.slice(0, k), whole), subtreeRoot(leaves.slice(k))];
  return [...subproof(m - k, leaves.slice(k), false), subtreeRoot(leaves.slice(0, k))];
}

// RFC 6962 2.1.2: shows the tree of the first m entries is a prefix of the tree of all of them.
export function consistencyPath(entryHashes: readonly Uint8Array[], m: number): Uint8Array[] {
  if (!Number.isSafeInteger(m) || m < 1 || m > entryHashes.length) throw new RangeError(`no prefix of size ${m} in a tree of ${entryHashes.length}`);
  return subproof(m, entryHashes.map(leafHash), true);
}

const isOdd = (n: number): boolean => n % 2 === 1;
const half = (n: number): number => Math.floor(n / 2);

// RFC 9162 2.1.4.2. Never throws: bad input just proves nothing.
export function verifyConsistency(m: number, n: number, rootM: Uint8Array, rootN: Uint8Array, path: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(m) || !Number.isSafeInteger(n) || m < 1 || m > n || path.length > MAX_PROOF_HASHES) return false;
  if (rootM.length !== HASH_BYTES || rootN.length !== HASH_BYTES || path.some((hash) => hash.length !== HASH_BYTES)) return false;
  if (m === n) return path.length === 0 && equalBytes(rootM, rootN);
  let fn = m - 1;
  let sn = n - 1;
  while (isOdd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  const hashes = fn === 0 ? [rootM, ...path] : [...path];
  const first = hashes[0];
  if (!first) return false;
  let fr = first;
  let sr = first;
  for (const c of hashes.slice(1)) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (!isOdd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equalBytes(fr, rootM) && equalBytes(sr, rootN);
}

// RFC 9162 2.1.3.2: shows this entry sits at this index in a tree of this size. Never throws.
export function verifyInclusion(entryHash: Uint8Array, index: number, size: number, root: Uint8Array, path: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size || path.length > MAX_PROOF_HASHES) return false;
  if (entryHash.length !== HASH_BYTES || path.some((hash) => hash.length !== HASH_BYTES)) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(entryHash);
  for (const p of path) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      r = nodeHash(p, r);
      while (!isOdd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equalBytes(r, root);
}

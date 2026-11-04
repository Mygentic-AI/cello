import { decodeEncoded, readHiddenChannels, stripInvisible } from "./sanitize.ts";

export interface ScanVariant {
  kind: string;
  text: string;
}

const LETTER_FORMS: Record<string, string> = {
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j",
  "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q", "ʀ": "r", "ꜱ": "s", "ᴛ": "t",
  "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
};

function foldLetters(text: string): string {
  const stripped = text.normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of stripped) out += LETTER_FORMS[ch] ?? ch;
  return out.replace(/\(([a-z])\)/gi, "$1").toLowerCase();
}

function joinSpacedLetters(text: string): string {
  return text
    .split(/\s{2,}|\n/)
    .map((group) => {
      const tokens = group.split(/[ ._\-*·]/);
      return tokens.length > 2 && tokens.every((t) => t.length <= 1) ? tokens.join("") : group;
    })
    .join(" ");
}

function splitJoinedWords(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-zA-Z])[_\-.]+([a-zA-Z])/g, "$1 $2");
}

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "l",
};
function foldLeet(text: string): string {
  let out = "";
  for (const ch of text) out += LEET[ch] ?? ch;
  return out;
}

const TURNED: Record<string, string> = {
  "ɐ": "a", "q": "b", "ɔ": "c", "p": "d", "ǝ": "e", "ɟ": "f", "ƃ": "g", "ɥ": "h", "ᴉ": "i", "ı": "i",
  "ɾ": "j", "ʞ": "k", "ɯ": "m", "u": "n", "d": "p", "b": "q", "ɹ": "r", "ʇ": "t", "n": "u", "ʌ": "v",
  "ʍ": "w", "ʎ": "y", "˙": ".",
};
function unturn(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) out += TURNED[ch] ?? ch;
  return out;
}

function reverse(text: string): string {
  return [...text].reverse().join("");
}

function caesar(text: string, n: number): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26) + base);
  });
}

function atbash(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
  });
}

function rot47(text: string): string {
  return text.replace(/[!-~]/g, (c) => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94)));
}

function decodeBinaryRuns(text: string): string {
  return text.replace(/(?:[01]{8}[\s,]{0,2}){4,}/g, (run) => {
    const bits = run.replace(/[^01]/g, "");
    let out = "";
    for (let i = 0; i + 8 <= bits.length; i += 8) out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    return /^[\x20-\x7e\n]+$/.test(out) ? out : run;
  });
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function untag(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp > 0xe0000 && cp < 0xe007f ? String.fromCodePoint(cp - 0xe0000) : ch;
  }
  const hidden = readHiddenChannels(text);
  return hidden.length > 0 ? `${out} ${hidden}` : out;
}

function readable(s: string): boolean {
  const visible = stripInvisible(untag(s)).text;
  if (visible.length < 4) return false;
  let ok = 0;
  for (const ch of visible) if (/[\p{L}\p{N}\p{P}\p{Zs}\n]/u.test(ch)) ok++;
  return ok / [...visible].length >= 0.9;
}

function decodeBase64Runs(text: string): string {
  return text.replace(/[A-Za-z0-9+/_-]{16,}={0,2}/g, (run) => {
    const s = Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return readable(s) ? stripInvisible(untag(s)).text : run;
  });
}

function decodeHexRuns(text: string): string {
  return text.replace(/(?:[0-9a-f]{2}[\s:]?){8,}/gi, (run) => {
    const hex = run.replace(/[\s:]/g, "");
    const s = Buffer.from(hex, "hex").toString("utf8");
    return readable(s) ? s : run;
  });
}

export function scanVariants(decodedForScan: string, hiddenText = ""): ScanVariant[] {
  const variants: ScanVariant[] = [{ kind: "decoded", text: decodedForScan }];
  const add = (kind: string, text: string): void => {
    if (text.length > 0 && !variants.some((v) => v.text === text)) variants.push({ kind, text });
  };
  add("hidden_codepoints", hiddenText);

  let redecoded = decodedForScan;
  for (let i = 0; i < 3; i++) {
    const d = decodeEncoded(redecoded);
    if (!d.changed) break;
    redecoded = d.text;
  }
  add("nested_encoding", redecoded);

  add("unicode_tags", stripInvisible(untag(redecoded)).text);

  const base = stripInvisible(redecoded).text;
  add("base64", decodeBase64Runs(base));
  add("hex", decodeHexRuns(base));
  const folded = foldLetters(base);
  const turned = unturn(base);
  add("reversed", reverse(folded));
  add("upside_down", reverse(turned));
  add("upside_down_unreversed", turned);
  add("rot13", rot13(base));
  add("atbash", atbash(base));
  add("rot47", rot47(base));
  add("binary", decodeBinaryRuns(base));
  add("caesar_3", caesar(base, 23));
  add("folded_letters", folded);
  add("spaced_letters_joined", joinSpacedLetters(folded));
  add("joined_words_split", foldLetters(splitJoinedWords(base)));
  add("leetspeak", foldLeet(folded));
  add("spaces_removed", folded.replace(/[\s_-]+/g, ""));
  return variants;
}

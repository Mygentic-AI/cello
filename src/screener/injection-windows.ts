
export function buildWindows(tokens: readonly number[], size: number, overlap: number): number[][] {
  if (size <= 0) throw new Error(`window size must be positive (got ${size})`);
  if (overlap >= size) {
    throw new Error(`window overlap ${overlap} must be smaller than the window size ${size}`);
  }
  if (tokens.length <= size) return [[...tokens]];

  const stride = size - overlap;
  const windows: number[][] = [];
  for (let start = 0; start < tokens.length; start += stride) {
    windows.push(tokens.slice(start, start + size));
    if (start + size >= tokens.length) break; // the tail is covered; another window would repeat it
  }
  return windows;
}

export function aggregateWindowScores(scores: readonly number[]): number {
  if (scores.length === 0) {
    throw new Error("cannot score a message with no windows — refusing to report an unscanned message as clean");
  }
  return Math.max(...scores);
}

export interface WindowTokenizer {
  encode(text: string): number[];
  decode(ids: number[], opts?: { skip_special_tokens?: boolean }): string;
}

export function textWindows(text: string, tok: WindowTokenizer | undefined, size: number, overlap: number): string[] {
  if (!tok || typeof tok.encode !== "function" || typeof tok.decode !== "function") return [text];
  let ids: number[];
  try {
    ids = tok.encode(text);
  } catch {
    return [text];
  }
  if (ids.length <= size) return [text];
  return buildWindows(ids, size, overlap).map((w) => tok.decode(w, { skip_special_tokens: true }));
}

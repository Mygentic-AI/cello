// THE one point where a channel's text is screened before it reaches an agent's context.
// Decision 9 lives here and in channels.ts #forContext: everything an agent reads from a channel passes through it.
// The screener isn't on this branch yet, so this refuses. Nothing from a channel reaches an agent unscreened.
import { LocalError } from "./engine.ts";

export type ScreenVerdict = { verdict: "clean" } | { verdict: "blocked"; reason: string };

export const screenForContext: (text: string) => Promise<ScreenVerdict> = () =>
  Promise.reject(new LocalError("screener_not_available", "This build has no screener, so channel text can't reach an agent. The posts are held safely, and nothing is lost."));

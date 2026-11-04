export interface RateLimitConfig {
  maxPerWindow: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  limited: boolean;
  reason?: "rate_limited";
  guidance?: string;
  retryAfterMs?: number;
}

export class OutboundRateLimiter {
  readonly #config: RateLimitConfig;
  readonly #now: () => number;
  readonly #sends = new Map<string, number[]>();

  constructor(config: RateLimitConfig, now: () => number = () => Date.now()) {
    this.#config = config;
    this.#now = now;
  }

  #live(agentIdentity: string, now: number): number[] {
    const all = this.#sends.get(agentIdentity);
    return all ? all.filter((t) => t > now - this.#config.windowMs) : [];
  }

  peek(agentIdentity: string): RateLimitVerdict {
    const now = this.#now();
    const live = this.#live(agentIdentity, now);
    if (live.length >= this.#config.maxPerWindow) {
      const oldest = live[0] as number;
      const retryAfterMs = Math.max(1, oldest + this.#config.windowMs - now);
      return {
        limited: true,
        reason: "rate_limited",
        guidance:
          `Outbound rate limit reached for this agent (${this.#config.maxPerWindow} messages per ` +
          `${Math.round(this.#config.windowMs / 1000)}s). This message was not sent. ` +
          `WHAT YOU CAN DO NOW: wait about ${Math.ceil(retryAfterMs / 1000)}s and retry — the window ` +
          `slides as older messages age out, so this clears itself.\n` +
          "To allow more, a person runs: cello-v2 config-set rate_max_per_window <higher number>",
        retryAfterMs,
      };
    }
    return { limited: false };
  }

  record(agentIdentity: string): void {
    const now = this.#now();
    const live = this.#live(agentIdentity, now);
    live.push(now);
    this.#sends.set(agentIdentity, live);
  }

  check(agentIdentity: string): RateLimitVerdict {
    const v = this.peek(agentIdentity);
    if (!v.limited) this.record(agentIdentity);
    return v;
  }
}

type Re2Instance = { test(s: string): boolean; exec(s: string): RegExpExecArray | null };
type Re2Factory = (pattern: string, flags: string) => Re2Instance;

let factory: Re2Factory | null = null;

// WASM only: the native engine compiles from source, which costs every operator install time for no gain in the guarantee.
export async function initLinearRegex(): Promise<void> {
  if (factory) return;
  const wasm = (await import("re2-wasm")) as unknown as { RE2: new (p: string, f: string) => Re2Instance };
  factory = (pattern, flags) => new wasm.RE2(pattern, flags.includes("u") ? flags : flags + "u");
}

export class LinearRegex {
  readonly #re: Re2Instance;

  constructor(pattern: string, flags = "") {
    if (!factory) {
      throw new Error("LinearRegex: call and await initLinearRegex() before constructing patterns");
    }
    this.#re = factory(pattern, flags);
  }

  test(s: string): boolean {
    return this.#re.test(s);
  }

  match(s: string): string | null {
    const m = this.#re.exec(s);
    return m ? m[0] : null;
  }

  exec(s: string): RegExpExecArray | null {
    return this.#re.exec(s);
  }
}

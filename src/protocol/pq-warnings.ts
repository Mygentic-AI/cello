const PQ_APIS = ["ML-KEM-768", "ML-DSA-44", "getPublicKey", "encapsulateBits", "decapsulateBits"] as const;
const PATTERN = new RegExp(`^The (${PQ_APIS.join("|")}) Web Crypto API `);

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const replaced = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w: Error) => {
    if (w.name === "ExperimentalWarning" && PATTERN.test(w.message)) return;
    for (const listener of replaced) listener(w);
  });
}

install();

export {};

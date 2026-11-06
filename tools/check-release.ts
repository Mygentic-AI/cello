// Refuses a release that would ship a client with nothing to trust or nobody to call.
// Run by the pre-tag gate and by the publish workflow before anything is published: `node tools/check-release.ts`.
// A client built with an empty shipped list shows every issuer as unknown until its first fetch, and one with no Concierge address
// ends setup without the call that proves the agent works. Neither shows up in a test, so this is the only place they are caught.
import { TEXT_SETTINGS } from "../src/daemon/settings.ts";
import { verifyIssuerList, type RootKey } from "../src/protocol/issuer-list.ts";
import { productionRootKeys } from "../src/protocol/issuer-roots.ts";
import { SHIPPED_ISSUER_LIST } from "../src/shipped-issuer-list.ts";

const DAY = 86_400;
// A client lives on people's machines for months, and its list only helps until it expires.
export const MIN_LIST_LIFE_DAYS = 60;

export async function releaseProblems(values: { shippedList: string | null; conciergeAddress: string; roots: readonly RootKey[]; now: number }): Promise<string[]> {
  const problems: string[] = [];
  if (!values.shippedList) {
    problems.push("SHIPPED_ISSUER_LIST in src/shipped-issuer-list.ts is empty. Put the signed list there, in base64.");
  } else {
    const bytes = new Uint8Array(Buffer.from(values.shippedList, "base64"));
    const checked = await verifyIssuerList(bytes, values.roots, values.now);
    if (!checked.ok) problems.push(`SHIPPED_ISSUER_LIST doesn't verify against the production root keys: ${checked.message}`);
    else if (checked.list.expires_at - values.now < MIN_LIST_LIFE_DAYS * DAY) problems.push(`SHIPPED_ISSUER_LIST expires in under ${MIN_LIST_LIFE_DAYS} days (at ${checked.list.expires_at}), so installs would soon have no list. Sign a fresh one.`);
  }
  if (!values.conciergeAddress.trim()) problems.push("The concierge_address default in src/daemon/settings.ts is empty. Put the Concierge's address there.");
  return problems;
}

if (import.meta.main) {
  const problems = await releaseProblems({ shippedList: SHIPPED_ISSUER_LIST, conciergeAddress: TEXT_SETTINGS.concierge_address.default, roots: productionRootKeys(), now: Math.floor(Date.now() / 1000) });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`RELEASE CHECK FAILED: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write("release check passed: the shipped issuer list verifies and the Concierge address is set\n");
}

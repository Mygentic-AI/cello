// The check that a server's logs hold no message text and no address of this machine. Every live test that crosses a real server uses it.
import assert from "node:assert/strict";

// Finding out this machine's address depends on someone else's service, and its outage mustn't fail a good run. The answer says what was checked.
export async function checkLogsClean(logs: string, texts: readonly string[], otherAddresses: readonly string[] = []): Promise<string[]> {
  for (const text of texts) {
    if (text.length >= 8) assert.ok(!logs.includes(text), `a message's text is in the server's logs: ${text.slice(0, 40)}`);
  }
  for (const address of otherAddresses) assert.ok(!logs.includes(address), `an address is in the server's logs: ${address}`);
  const addressesChecked: string[] = [];
  for (const lookup of ["https://api.ipify.org", "https://api6.ipify.org"]) {
    let address: string;
    try {
      address = (await (await fetch(lookup, { signal: AbortSignal.timeout(10_000) })).text()).trim();
    } catch {
      continue;
    }
    if (!/^[0-9a-f.:]+$/i.test(address)) continue;
    assert.ok(!logs.includes(address), "this machine's address is in the server's logs");
    addressesChecked.push(address.includes(":") ? "IPv6" : "IPv4");
  }
  return addressesChecked;
}

// The page itself, as strings, so it ships inside the build with nothing to copy and nothing fetched from anywhere.
// It shows what the daemon returns, as text, and never as markup: a signal's words come from an issuer, and a contact's
// moniker from a stranger.

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CELLO</title>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<header>
  <h1>CELLO</h1>
  <label>Agent <select id="agent"></select></label>
</header>
<p id="problem" role="alert" hidden></p>
<main id="sections"></main>
<script src="/page.js"></script>
</body>
</html>
`;

const CSS = `:root { color-scheme: light dark; --edge: #8886; --soft: #8882; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 56rem; padding: 0 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 0; }
h1 { font-size: 1.25rem; margin: 0; }
h2 { font-size: 1.05rem; margin: 32px 0 8px; }
select { font: inherit; max-width: 100%; }
section.off { opacity: 0.5; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--edge); vertical-align: top; }
th { font-weight: 600; white-space: nowrap; }
td.key { font-family: ui-monospace, monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
#problem { background: var(--soft); border-left: 4px solid #c33; padding: 8px 12px; }
`;

const JS = `"use strict";
const SECTIONS = [
  { id: "agents", title: "Agents", method: "agents", pick: (r) => r.agents },
  { id: "signals", title: "Signals", method: "signals_list", perAgent: true, pick: (r) => r.signals },
  { id: "contacts", title: "Contacts", method: "contacts", perAgent: true, pick: (r) => r.contacts },
  { id: "settings", title: "Settings", method: "settings", pick: (r) => r.settings },
  { id: "guards", title: "Guards", method: "config", perAgent: true, pick: (r) => r.guards },
  { id: "track", title: "Track record", off: true, note: "Coming soon: how much you use CELLO and who you reach." },
];

let token = "";
try { token = sessionStorage.getItem("token") || ""; } catch { /* a private window: the link has to be used again after a reload */ }
if (location.hash.length > 1) {
  token = location.hash.slice(1);
  try { sessionStorage.setItem("token", token); } catch { /* as above */ }
  history.replaceState(null, "", location.pathname);
}

const problem = document.getElementById("problem");
const sections = document.getElementById("sections");
const picker = document.getElementById("agent");

function say(text) {
  problem.textContent = text;
  problem.hidden = text === "";
}

async function read(method, params) {
  const query = new URLSearchParams(params).toString();
  const reply = await fetch("/api/" + method + (query ? "?" + query : ""), { headers: { authorization: "Bearer " + token } });
  const body = await reply.json();
  if (!body.ok) throw new Error(body.error.message);
  return body.result;
}

function show(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const KEYS = /(^|_)(id|hash|address|pubkey)$/;

function table(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const t = document.createElement("table");
  const head = t.createTHead().insertRow();
  for (const name of columns) {
    const th = document.createElement("th");
    th.textContent = name.replaceAll("_", " ");
    head.append(th);
  }
  const body = t.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const name of columns) {
      const td = tr.insertCell();
      td.textContent = show(row[name]);
      if (KEYS.test(name)) td.className = "key";
    }
  }
  wrap.append(t);
  return wrap;
}

function frame(section) {
  const el = document.createElement("section");
  el.id = section.id;
  if (section.off) el.className = "off";
  const h = document.createElement("h2");
  h.textContent = section.title;
  el.append(h);
  if (section.note) {
    const p = document.createElement("p");
    p.textContent = section.note;
    el.append(p);
  }
  return el;
}

async function load() {
  say("");
  sections.replaceChildren();
  const agent = picker.value;
  for (const section of SECTIONS) {
    const el = frame(section);
    sections.append(el);
    if (section.off) continue;
    if (section.perAgent && !agent) continue;
    try {
      const params = section.perAgent || section.id === "settings" ? (agent ? { agent } : {}) : {};
      const rows = section.pick(await read(section.method, params)) || [];
      if (rows.length) el.append(table(rows));
    } catch (err) {
      say(section.title + ": " + err.message);
    }
  }
}

async function start() {
  if (!token) {
    say("Open this page from the link the cello account command prints.");
    return;
  }
  try {
    const { agents } = await read("agents", {});
    picker.replaceChildren(...agents.map((a) => Object.assign(document.createElement("option"), { value: a.agent_id, textContent: a.name })));
  } catch (err) {
    say(err.message);
    return;
  }
  picker.addEventListener("change", load);
  await load();
}

start();
`;

export const ACCOUNT_PAGE_ASSETS: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: HTML },
  "/page.css": { type: "text/css; charset=utf-8", body: CSS },
  "/page.js": { type: "text/javascript; charset=utf-8", body: JS },
};

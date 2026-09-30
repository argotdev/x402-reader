/**
 * Personas: the people this reader can act for, and which agents they send.
 *
 * personas.json is a roster of invented people. Each becomes a fixture identity in Baselayer's
 * sandbox on first use (fake details derived from the entry), and each gets its own free-read
 * allowances and its own unrelated identifier at every publisher.
 *
 *   pnpm personas                 what each persona looks like from here and from each publisher
 *   pnpm ask --as bob "..."       act for bob (default persona: PERSON env, then alice)
 *   pnpm read --as alice --agent agent-b <slug>
 */
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Persona = { name: string; about?: string; agents?: string[] };
export type Selection = { person: string; agent: string; anonymous: boolean; persona: Persona | null };

const ROOT = path.resolve(process.env.KYA_STORE ?? ".kya");

export async function loadPersonas(): Promise<Record<string, Persona>> {
  try {
    return JSON.parse(await readFile(new URL("./personas.json", import.meta.url), "utf8")) as Record<string, Persona>;
  } catch {
    return {};
  }
}

/** Parse --as, --agent, --no-credential / --anonymous out of argv. Returns the remaining args too. */
export async function selectPersona(argv: string[]): Promise<{ selection: Selection; rest: string[] }> {
  const rest: string[] = [];
  let person = process.env.PERSON ?? "alice";
  let agent = process.env.AGENT_NAME ?? "";
  let anonymous = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--as" && argv[i + 1]) person = argv[++i];
    else if (a.startsWith("--as=")) person = a.slice(5);
    else if (a === "--agent" && argv[i + 1]) agent = argv[++i];
    else if (a.startsWith("--agent=")) agent = a.slice(8);
    else if (a === "--no-credential" || a === "--anonymous") anonymous = true;
    else rest.push(a);
  }
  const personas = await loadPersonas();
  const persona = personas[person] ?? personas[person.replace(/-.*$/, "")] ?? null;
  if (!agent) agent = persona?.agents?.[0] ?? "agent-a";
  return { selection: { person, agent, anonymous, persona }, rest };
}

/** Publishers to ask what they know, from PUBLISHERS (comma-separated) or the two demo sites. */
export function publishers(): string[] {
  const env = process.env.PUBLISHERS ?? process.env.SITE_URL ?? "";
  const list = env.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  const defaults = ["https://www.thedailyagent.news", "https://www.thedelegate.tech"];
  // One entry per site: the apex and its www are the same publisher.
  const seen = new Set<string>();
  return [...list, ...defaults].filter((u) => {
    const host = new URL(u).host.replace(/^www\./, "");
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

type StoredCredential = { audience: string; credential: string; jti: string; expires_at: string; sub: string };

/** Everything on disk about a persona: verification, agents, cached credentials. */
export function localState(person: string) {
  const peopleFile = path.join(ROOT, "people", `${person}.json`);
  const verified = existsSync(peopleFile) ? (JSON.parse(readFileSync(peopleFile, "utf8")) as { principal_ref: string; verified_at?: string }) : null;
  const agentsDir = path.join(ROOT, "agents");
  const agents: { agent: string; credentials: StoredCredential[] }[] = [];
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const credDir = path.join(agentsDir, agent, "credentials", person);
      const credentials = existsSync(credDir)
        ? readdirSync(credDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(credDir, f), "utf8")) as StoredCredential)
        : [];
      if (credentials.length > 0 || existsSync(path.join(agentsDir, agent, "key.json"))) agents.push({ agent, credentials });
    }
  }
  return { verified, agents };
}

// ---- pnpm personas ----------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("personas.ts")) {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const personas = await loadPersonas();
  const sites = publishers();
  type ReaderRow = { reader: string; freeReadsThisMonth: number; paidReads: number; wallets: string[] };
  const tables = new Map<string, { audience: string; free: number; readers: ReaderRow[] } | null>();
  await Promise.all(
    sites.map(async (site) => {
      try {
        const r = await fetch(`${site}/api/readers`);
        const d = (await r.json()) as { audience: string; freeReadsPerMonth: number; readers: ReaderRow[] };
        tables.set(site, r.ok ? { audience: d.audience, free: d.freeReadsPerMonth, readers: d.readers } : null);
      } catch {
        tables.set(site, null);
      }
    }),
  );

  // Baselayer's own issuance records give every identifier a persona has ever been issued, so a
  // publisher's table can be matched even when the local credential cache has expired or been cleared.
  const issuedSubjects = new Map<string, Set<string>>();
  if (process.env.BASELAYER_API_KEY) {
    const res = await fetch(`${process.env.BASELAYER_API_URL ?? "https://api.baselayer.com"}/issued_credentials?limit=500`, { headers: { "X-API-Key": process.env.BASELAYER_API_KEY } });
    if (res.ok) {
      for (const c of (await res.json()) as { principal_ref: string | null; subject: string | null }[]) {
        if (!c.principal_ref || !c.subject) continue;
        if (!issuedSubjects.has(c.principal_ref)) issuedSubjects.set(c.principal_ref, new Set());
        issuedSubjects.get(c.principal_ref)!.add(c.subject);
      }
    }
  }

  // Include people who exist on disk but not in the roster.
  const onDisk = existsSync(path.join(ROOT, "people")) ? readdirSync(path.join(ROOT, "people")).map((f) => f.replace(/\.json$/, "")) : [];
  const names = [...new Set([...Object.keys(personas), ...onDisk])];

  for (const person of names) {
    const p = personas[person];
    const state = localState(person);
    console.log(`\n${bold(person)}${p ? `  ${p.name}` : dim("  (not in personas.json)")}`);
    if (p?.about) console.log(dim(`  ${p.about}`));
    console.log(`  ${state.verified ? `verified as principal …${state.verified.principal_ref.slice(-8)}` : dim("not yet verified: first read creates a fixture identity")}`);
    const agentsWithCreds = state.agents.filter((a) => a.credentials.length > 0);
    for (const agent of p?.agents ?? agentsWithCreds.map((a) => a.agent)) {
      const a = state.agents.find((x) => x.agent === agent);
      const keyed = existsSync(path.join(ROOT, "agents", agent, "key.json"));
      console.log(`  agent ${agent}${keyed ? "" : dim(" (no key yet)")}`);
      for (const c of a?.credentials ?? []) {
        const left = Math.round((new Date(c.expires_at).getTime() - Date.now()) / 60000);
        console.log(`    ${c.audience.padEnd(26)} reader …${c.sub.slice(-12)}  ${left > 0 ? `${left} min left` : "expired"}`);
      }
    }
    // What each publisher knows: match this person's identifiers against their readers tables.
    const subs = new Set(state.agents.flatMap((a) => a.credentials.map((c) => c.sub)));
    for (const sub of issuedSubjects.get(state.verified?.principal_ref ?? "") ?? []) subs.add(sub);
    for (const site of sites) {
      const t = tables.get(site);
      if (!t) continue;
      const row = t.readers.find((r) => subs.has(r.reader));
      const host = new URL(site).host;
      if (row) console.log(`  ${host.padEnd(28)} knows …${row.reader.slice(-8)}: ${row.freeReadsThisMonth}/${t.free} free reads, ${row.paidReads} paid, ${row.wallets.length} wallet${row.wallets.length === 1 ? "" : "s"}`);
      else console.log(dim(`  ${host.padEnd(28)} has never seen this person`));
    }
  }
  console.log(dim(`\nPublishers asked: ${sites.join(", ")}. Set PUBLISHERS to change.`));
  console.log(dim("Use a persona: pnpm ask --as <name> [--agent <agent>] \"...\"   pnpm read --as <name> <slug>"));
}

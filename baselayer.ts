/**
 * The issuer's view. What Baselayer knows about the people and credentials this reader created.
 *
 *   pnpm baselayer people                       everyone this org has verified
 *   pnpm baselayer person <persona|prn_…>       one identity in detail, with its credentials
 *   pnpm baselayer credentials [--person x] [--audience y] [--state ACTIVE|EXPIRED|REVOKED]
 *   pnpm baselayer credential <jti>             one issuance record
 *   pnpm baselayer revoke <jti>                 kill a credential; publishers reject it within a minute
 *   pnpm baselayer audit <persona|prn_…>        the tamper-evident log for one person
 *   pnpm baselayer issuer                       the public DID document and signing keys
 *
 * Needs BASELAYER_API_KEY. Everything is scoped to that key's organisation and environment.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const API = process.env.BASELAYER_API_URL ?? "https://api.baselayer.com";
const KEY = process.env.BASELAYER_API_KEY;
const ROOT = path.resolve(process.env.KYA_STORE ?? ".kya");
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const [cmd = "people", ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !args[i - 1].includes("=")));

async function api<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  if (!KEY) {
    console.error("BASELAYER_API_KEY is not set in .env");
    process.exit(1);
  }
  const res = await fetch(API + route, { ...init, headers: { "X-API-Key": KEY, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body, headers: res.headers };
}

/** A persona name resolves to its principal_ref via .kya/people; a prn_ passes through. */
async function principalRef(nameOrRef: string): Promise<string> {
  if (nameOrRef.startsWith("prn_")) return nameOrRef;
  try {
    const saved = JSON.parse(await readFile(path.join(ROOT, "people", `${nameOrRef}.json`), "utf8")) as { principal_ref: string };
    return saved.principal_ref;
  } catch {
    console.error(`No local record for persona "${nameOrRef}". Run a read as them first, or pass a prn_ reference.`);
    process.exit(1);
  }
}

async function personaNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { readdir } = await import("node:fs/promises");
    for (const f of await readdir(path.join(ROOT, "people"))) {
      const saved = JSON.parse(await readFile(path.join(ROOT, "people", f), "utf8")) as { principal_ref: string };
      map.set(saved.principal_ref, f.replace(/\.json$/, ""));
    }
  } catch {
    /* no local people yet */
  }
  return map;
}

const when = (iso?: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "");
const short = (s?: string | null, n = 8) => (s ? `…${s.slice(-n)}` : "");

type Principal = { principal_ref: string; display_name: string; verification_state: string; verification_level: number | null; active_keys: string[]; credentials_minted_30d?: number; verified_at: string; expires_at: string; credential_activity?: { credentials_minted_30d: number; last_minted_at: string | null }; submissions?: { submission_id: string; verdict: string; completed_at: string; reference_id?: string }[] };
type Issued = { jti: string; credential_type: string; status: string; revoked_at: string | null; principal_ref: string | null; audience: string; subject: string | null; issued_at: string; expires_at: string; agent_key_kid: string | null; minted_by: string | null };

switch (cmd) {
  case "people": {
    const { body, headers } = await api<Principal[]>("/identities/principals?limit=200");
    const names = await personaNames();
    console.log(bold(`${headers.get("x-total-count") ?? body.length} verified people in this organisation`));
    for (const p of body) {
      const local = names.get(p.principal_ref);
      console.log(`  ${(local ?? "").padEnd(12)} ${p.display_name.padEnd(18)} ${short(p.principal_ref, 10).padEnd(12)} ${p.verification_state.padEnd(9)} ${String(p.credentials_minted_30d ?? 0).padStart(3)} credentials/30d  verified ${when(p.verified_at)}`);
    }
    console.log(dim("\nFirst column: the local persona name, when this reader created the identity."));
    break;
  }
  case "person": {
    const ref = await principalRef(positional[0] ?? process.env.PERSON ?? "alice");
    const { status, body } = await api<Principal>(`/identities/principals/${ref}`);
    if (status !== 200) { console.error(`${status}:`, JSON.stringify(body)); process.exit(1); }
    console.log(bold(body.display_name), dim(body.principal_ref));
    console.log(`  state ${body.verification_state}, level ${body.verification_level ?? "n/a"}, attests to [${body.active_keys.join(", ")}]`);
    console.log(`  verified ${when(body.verified_at)}, expires ${when(body.expires_at)}`);
    if (body.credential_activity) console.log(`  ${body.credential_activity.credentials_minted_30d} credentials minted in 30 days, last ${when(body.credential_activity.last_minted_at) || "never"}`);
    for (const s of body.submissions ?? []) console.log(`  submission ${short(s.submission_id, 8)} ${s.verdict} ${when(s.completed_at)} ${s.reference_id ? dim(s.reference_id) : ""}`);
    const creds = await api<Issued[]>(`/issued_credentials?principal_ref=${encodeURIComponent(ref)}&limit=100`);
    console.log(bold(`\n${creds.body.length} credentials`));
    printCredentials(creds.body);
    break;
  }
  case "credentials": {
    const q = new URLSearchParams({ limit: "200" });
    const person = flag("person");
    if (person) q.set("principal_ref", await principalRef(person));
    if (flag("audience")) q.set("audience", flag("audience")!);
    if (flag("state")) q.set("lifecycle_state", flag("state")!.toUpperCase());
    const { body, headers } = await api<Issued[]>(`/issued_credentials?${q}`);
    const names = await personaNames();
    console.log(bold(`${headers.get("x-total-count") ?? body.length} credentials${person ? ` for ${person}` : ""}`));
    printCredentials(body, names);
    break;
  }
  case "credential": {
    const jti = positional[0];
    if (!jti) { console.error("usage: pnpm baselayer credential <jti>"); process.exit(1); }
    const { status, body } = await api<Issued>(`/issued_credentials/${jti}`);
    console.log(status, JSON.stringify(body, null, 2));
    break;
  }
  case "revoke": {
    const jti = positional[0];
    if (!jti) { console.error("usage: pnpm baselayer revoke <jti>"); process.exit(1); }
    const { status, body } = await api<Issued>(`/issued_credentials/${jti}/revoke`, { method: "POST" });
    if (status !== 200) { console.error(`${status}:`, JSON.stringify(body)); process.exit(1); }
    console.log(`${bold("Revoked")} ${body.jti} for ${body.audience} at ${when(body.revoked_at)}.`);
    console.log(dim("Publishers check the issuer's status list on every presentation and cache it for up to a minute; the next request with this credential will be refused with REVOKED and the reader will mint a fresh one."));
    break;
  }
  case "audit": {
    const ref = await principalRef(positional[0] ?? process.env.PERSON ?? "alice");
    const { status, body } = await api<{ seq: number; event: Record<string, unknown> & { event_type: string; occurred_at: string } }[]>(`/audit-log?principal_ref=${encodeURIComponent(ref)}&limit=200`);
    if (status !== 200) { console.error(`${status}:`, JSON.stringify(body)); process.exit(1); }
    console.log(bold(`${body.length} audit events for ${short(ref, 10)}`), dim("(sequence numbers are Merkle leaf positions in Baselayer's append-only log)"));
    for (const { seq, event } of body) {
      const e = event as Record<string, string | undefined>;
      const detail =
        event.event_type === "issuance" ? `${e.credential_type} for ${e.audience}, jti ${short(e.jti, 8)}, agent key ${short(e.agent_key_thumbprint, 8)}, expires ${when(e.expires_at)}`
        : event.event_type === "credential_revocation" ? `jti ${short(e.jti, 8)} for ${e.audience}, reason ${e.reason}`
        : event.event_type === "identity_registration" ? `verdict ${e.verdict}, submission ${short(e.submission_id, 8)}`
        : JSON.stringify(event);
      console.log(`  #${String(seq).padStart(6)}  ${when(event.occurred_at)}  ${event.event_type.padEnd(22)} ${detail}`);
    }
    break;
  }
  case "issuer": {
    const did = await (await fetch("https://registry.baselayer.com/.well-known/did.json")).json() as { id: string; verificationMethod: { publicKeyJwk: { kid: string; crv: string } }[] };
    const sl = await fetch("https://registry.baselayer.com/statuslists/1");
    const slPayload = JSON.parse(Buffer.from((await sl.text()).split(".")[1], "base64url").toString()) as { ttl?: number; status_list: { bits: number } };
    console.log(bold(did.id));
    console.log(`  DID document  https://registry.baselayer.com/.well-known/did.json`);
    for (const m of did.verificationMethod) console.log(`  signing key   ${m.publicKeyJwk.kid} (${m.publicKeyJwk.crv})`);
    console.log(`  status list   https://registry.baselayer.com/statuslists/1  (${slPayload.status_list.bits} bit per credential, ttl ${slPayload.ttl ?? "?"}s)`);
    console.log(dim("\nPublishers verify credentials against these without an API key."));
    break;
  }
  default:
    console.error("commands: people, person, credentials, credential, revoke, audit, issuer");
    process.exit(1);
}

function printCredentials(list: Issued[], names?: Map<string, string>) {
  for (const c of list) {
    const who = names && c.principal_ref ? (names.get(c.principal_ref) ?? short(c.principal_ref, 6)).padEnd(12) : "";
    const state = c.status === "REVOKED" ? "REVOKED" : new Date(c.expires_at).getTime() < Date.now() ? "expired" : "valid";
    console.log(`  ${who}${c.credential_type} ${state.padEnd(8)} ${c.audience.padEnd(26)} reader ${short(c.subject, 12).padEnd(14)} agent ${(c.agent_key_kid ?? "").padEnd(12)} issued ${when(c.issued_at)}  jti ${c.jti}`);
  }
}

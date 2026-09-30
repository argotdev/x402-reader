/**
 * The reader's identity: a Baselayer Know Your Agent credential, presented to publishers that
 * recognise returning readers.
 *
 * The person behind the agent is verified once with Baselayer (here: a fixture identity in
 * the sandbox, created on first use from fake details) and gets a principal_ref. For each
 * publisher the agent visits, it mints a short-lived L2 credential scoped to that publisher's
 * audience and bound to the agent's own Ed25519 key. On every request it fetches a single-use
 * nonce from the publisher and signs a key binding JWT, so a copied credential is useless.
 *
 * State lives in .kya/: people/<person>.json, agents/<agent>/key.json, agents/<agent>/<audience>.json.
 *
 * Env: BASELAYER_API_KEY   sandbox or production key with identity and credential permissions
 *      PERSON              who the agent acts for (default alice); one fixture identity per name
 *      AGENT_NAME          this agent's key (default agent-a); two agents for one person share a reader
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASELAYER = process.env.BASELAYER_API_URL ?? "https://api.baselayer.com";
const API_KEY = process.env.BASELAYER_API_KEY;
export const PERSON = process.env.PERSON ?? "alice";
export const AGENT_NAME = process.env.AGENT_NAME ?? "agent-a";
const ROOT = path.resolve(process.env.KYA_STORE ?? ".kya");

export type PublisherProfile = {
  audience: string;
  presentation: { header: string; nonce_endpoint: string };
  access?: { free_reads_per_month?: number };
  scopes?: { id: string; level: string }[];
};

type Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; d?: string; kid?: string };
type StoredCredential = { audience: string; credential: string; jti: string; expires_at: string; sub: string };

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

async function baselayer<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  if (!API_KEY) throw new Error("BASELAYER_API_KEY is not set");
  const res = await fetch(BASELAYER + route, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Deterministic fake details for a named person. Sandbox accepts them as a fixture identity. */
function fixtureIdentity(person: string) {
  const digits = createHash("sha256").update(person).digest("hex").replace(/\D/g, "").padEnd(16, "7");
  const first = person.charAt(0).toUpperCase() + person.slice(1).toLowerCase();
  return {
    first_name: first,
    last_name: "Reader",
    dob: `198${digits[0]}-0${(Number(digits[1]) % 9) + 1}-1${digits[2]}`,
    phone_number: `+1212555${digits.slice(3, 7)}`,
    email: `${person.toLowerCase()}@example.com`,
    address: `${digits.slice(7, 10)} Market St, Wilmington, DE 19801`,
    national_id: digits.slice(10, 19).padEnd(9, "1"),
  };
}

export class Reader {
  readonly person: string;
  readonly agent: string;
  readonly enabled = Boolean(API_KEY);
  private profiles = new Map<string, PublisherProfile | null>();
  private key: { publicJwk: Jwk; privateJwk: Jwk } | null = null;
  // Parallel first-contact requests share one verification, one key, one mint per audience.
  private inflight = new Map<string, Promise<unknown>>();

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = work().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
  /** Narration hook: called with one line each time something worth telling happens. */
  onEvent: (line: string) => void = () => {};

  constructor(person = PERSON, agent = AGENT_NAME) {
    this.person = person;
    this.agent = agent;
  }

  /** The verified person this agent acts for. Created in the sandbox on first use. */
  principal(): Promise<string> {
    return this.once("principal", () => this.loadPrincipal());
  }

  private async loadPrincipal(): Promise<string> {
    const file = path.join(ROOT, "people", `${this.person}.json`);
    const saved = await readJson<{ principal_ref: string }>(file);
    if (saved?.principal_ref) return saved.principal_ref;

    this.onEvent(`Verifying "${this.person}" with Baselayer (fixture identity, fake details)`);
    const submit = await baselayer<{ submission_id: string; state: string }>("POST", "/identity_submissions/consumer", {
      idempotency_key: `x402-reader:${this.person}`,
      reference_id: `x402-reader ${this.person}`,
      consumer: fixtureIdentity(this.person),
    });
    if (submit.status !== 202 && submit.status !== 409) throw new Error(`identity submission failed: ${submit.status} ${JSON.stringify(submit.body)}`);
    const id = submit.body.submission_id;
    for (let i = 0; i < 30; i++) {
      const poll = await baselayer<{ state: string; verdict?: string; principal_ref?: string }>("GET", `/identity_submissions/${id}`);
      if (["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"].includes(poll.body.state)) {
        if (poll.body.verdict !== "APPROVED" || !poll.body.principal_ref) throw new Error(`identity not approved: ${poll.body.state} ${poll.body.verdict ?? ""}`);
        await writeJson(file, { person: this.person, principal_ref: poll.body.principal_ref, verified_at: new Date().toISOString() });
        this.onEvent(`Verified. principal_ref …${poll.body.principal_ref.slice(-8)}`);
        return poll.body.principal_ref;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("identity verification did not complete");
  }

  /** This agent's own signing key, generated once. Baselayer only ever sees the public half. */
  private agentKey() {
    if (this.key) return Promise.resolve(this.key);
    return this.once("key", () => this.loadAgentKey());
  }

  private async loadAgentKey() {
    if (this.key) return this.key;
    const file = path.join(ROOT, "agents", this.agent, "key.json");
    const saved = await readJson<{ publicJwk: Jwk; privateJwk: Jwk }>(file);
    if (saved) return (this.key = saved);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid: this.agent };
    const privateJwk = privateKey.export({ format: "jwk" }) as Jwk;
    await writeJson(file, { publicJwk, privateJwk });
    this.onEvent(`Generated a signing key for ${this.agent}`);
    return (this.key = { publicJwk, privateJwk });
  }

  /** Does this publisher recognise reader credentials? Cached per origin for the run. */
  profile(origin: string): Promise<PublisherProfile | null> {
    if (this.profiles.has(origin)) return Promise.resolve(this.profiles.get(origin)!);
    return this.once(`profile:${origin}`, () => this.loadProfile(origin));
  }

  private async loadProfile(origin: string): Promise<PublisherProfile | null> {
    if (this.profiles.has(origin)) return this.profiles.get(origin)!;
    let profile: PublisherProfile | null = null;
    try {
      const res = await fetch(`${origin}/.well-known/kya-profile.json`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const p = (await res.json()) as PublisherProfile;
        if (p.audience && p.presentation?.header && p.presentation?.nonce_endpoint) profile = p;
      }
    } catch {
      profile = null;
    }
    this.profiles.set(origin, profile);
    return profile;
  }

  /** A credential for this audience: cached until it expires, minted otherwise. */
  credential(audience: string, fresh = false): Promise<StoredCredential> {
    return this.once(`credential:${audience}:${fresh}`, () => this.loadCredential(audience, fresh));
  }

  private async loadCredential(audience: string, fresh: boolean): Promise<StoredCredential> {
    const file = path.join(ROOT, "agents", this.agent, `${audience}.json`);
    if (!fresh) {
      const saved = await readJson<StoredCredential>(file);
      if (saved && new Date(saved.expires_at).getTime() - Date.now() > 60_000) return saved;
    }
    const principal_ref = await this.principal();
    const { publicJwk } = await this.agentKey();
    const mint = await baselayer<{ credential?: string; jti: string; expires_at: string; message?: string }>("POST", "/credentials/individual", {
      principal_ref,
      level: "L2",
      audience,
      agent_key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid: publicJwk.kid },
    });
    if (mint.status !== 201 || !mint.body.credential) throw new Error(`mint failed: ${mint.status} ${mint.body.message ?? JSON.stringify(mint.body)}`);
    const payload = JSON.parse(Buffer.from(mint.body.credential.split("~")[0].split(".")[1], "base64url").toString()) as { sub: string };
    const stored: StoredCredential = { audience, credential: mint.body.credential, jti: mint.body.jti, expires_at: mint.body.expires_at, sub: payload.sub };
    await writeJson(file, stored);
    this.onEvent(`Minted a reader credential for ${audience} (reader …${payload.sub.slice(-8)}, valid ${Math.round((new Date(stored.expires_at).getTime() - Date.now()) / 60000)} min)`);
    return stored;
  }

  /**
   * The header to send with one request to this publisher: credential plus a key binding JWT
   * over the publisher's audience and a nonce it just issued. Null if the publisher does not
   * recognise credentials or this reader has none.
   */
  async presentation(origin: string, fresh = false): Promise<{ header: string; value: string; reader: string } | null> {
    if (!this.enabled) return null;
    const profile = await this.profile(origin);
    if (!profile) return null;
    const cred = await this.credential(profile.audience, fresh);
    const nonceRes = await fetch(profile.presentation.nonce_endpoint, { method: "POST" });
    if (!nonceRes.ok) throw new Error(`nonce endpoint answered ${nonceRes.status}`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const { privateJwk } = await this.agentKey();
    const kb = { iat: Math.floor(Date.now() / 1000), aud: profile.audience, nonce, sd_hash: createHash("sha256").update(cred.credential).digest("base64url") };
    const signingInput = `${enc({ alg: "EdDSA", typ: "kb+jwt" })}.${enc(kb)}`;
    const signature = sign(null, Buffer.from(signingInput), createPrivateKey({ key: privateJwk, format: "jwk" })).toString("base64url");
    return { header: profile.presentation.header, value: `${cred.credential}${signingInput}.${signature}`, reader: cred.sub };
  }
}

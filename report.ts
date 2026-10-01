/**
 * Who read what, where. Three views of one person, side by side.
 *
 *   pnpm report --as alice
 *
 * 1. The reader's own history: every piece, every site, how it was paid for. Only the reader can
 *    produce this list, because only the reader knows which pseudonym is theirs at each publisher.
 * 2. What each publisher reports about that pseudonym: counts and the pieces read there. One site
 *    at a time; nothing to join them on.
 * 3. What Baselayer holds: that the person is verified and which publishers credentials were
 *    minted for. Not a single title.
 */
import { readHistory } from "./history.ts";
import { localState, publishers, selectPersona } from "./personas.ts";
import { explorerUrl } from "./paid-fetch.ts";

const { selection } = await selectPersona(process.argv.slice(2));
const person = selection.person;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toFixed(2)}`;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + "Z";

const history = await readHistory(person);
const sites = [...new Set([...publishers(), ...history.map((h) => new URL(h.url).origin)])];

// Titles and readers tables from every site involved.
type IndexArticle = { slug: string; title: string; urls: { html: string } };
type ReaderRow = { reader: string; freeReadsThisMonth: number; paidReads: number; wallets: string[]; reads?: { at: string; slug: string; access: string }[] };
type Purchase = { at: string; slug: string; amount: string; transaction: string; reader?: string };
const siteData = new Map<string, { name: string; titles: Map<string, string>; readers: ReaderRow[]; free: number; purchases: Purchase[] }>();
await Promise.all(
  sites.map(async (site) => {
    try {
      const [idx, readers, ledger] = await Promise.all([
        fetch(`${site}/articles.json`).then((r) => r.json()) as Promise<{ site: { name: string }; articles: IndexArticle[] }>,
        fetch(`${site}/api/readers`).then((r) => r.json()) as Promise<{ freeReadsPerMonth: number; readers: ReaderRow[] }>,
        fetch(`${site}/api/ledger`).then((r) => r.json()) as Promise<{ purchases: Purchase[] }>,
      ]);
      siteData.set(site, { name: idx.site.name, titles: new Map(idx.articles.map((a) => [a.slug, a.title])), readers: readers.readers, free: readers.freeReadsPerMonth, purchases: ledger.purchases });
    } catch {
      /* site unreachable; shown as such */
    }
  }),
);
const slugOf = (url: string) => url.replace(/^.*\/articles\//, "").replace(/\.(md|json)$/, "");
const titleOf = (site: string, slug: string) => siteData.get(site)?.titles.get(slug) ?? slug;
const hostOf = (site: string) => new URL(site).host.replace(/^www\./, "");

// ---- 1. the reader's own record ----
console.log(bold(`What ${person} read`), dim(`(${history.length} reads, from this reader's own history)`));
if (history.length === 0) console.log(dim("  nothing yet"));
for (const site of sites) {
  const here = history.filter((h) => new URL(h.url).origin === site);
  if (here.length === 0) continue;
  console.log(`\n  ${bold(siteData.get(site)?.name ?? hostOf(site))} ${dim(hostOf(site))}`);
  for (const h of here) {
    const how =
      h.access === "paid" ? `paid ${usd(h.amountAtomic ?? "0")}${h.transaction ? dim(`  ${explorerUrl({ network: h.network ?? "", transaction: h.transaction, url: h.url, amountAtomic: 0n, payer: "" }) ?? h.transaction}`) : ""}`
      : h.access === "free-read" ? `free read ${h.freeReadsUsed} as a recognised reader`
      : "free to all";
    console.log(`    ${dim(when(h.at))}  ${titleOf(site, slugOf(h.url))}  ${dim("via " + h.agent)}\n      ${how}`);
  }
}
const spent = history.filter((h) => h.access === "paid").reduce((n, h) => n + Number(h.amountAtomic ?? 0), 0);
console.log(`\n  ${history.filter((h) => h.access === "free-read").length} free reads as a recognised reader, ${history.filter((h) => h.access === "paid").length} paid for ${usd(String(spent))}, ${history.filter((h) => h.access === "free").length} free to all.`);

// ---- 2. what each publisher can say ----
const myReaders = new Set<string>([
  ...history.map((h) => h.reader).filter((r): r is string => Boolean(r)),
  ...localState(person).agents.flatMap((a) => a.credentials.map((c) => c.sub)),
]);
console.log(`\n${bold("What each publisher can report about this person")} ${dim("(from their public readers tables and ledgers)")}`);
for (const site of sites) {
  const d = siteData.get(site);
  if (!d) { console.log(`\n  ${hostOf(site)}: ${dim("unreachable")}`); continue; }
  const row = d.readers.find((r) => myReaders.has(r.reader));
  console.log(`\n  ${bold(d.name)} ${dim(hostOf(site))}`);
  if (!row) { console.log(dim("    no recognised reader matching this person. Anonymous paid reads, if any, appear in the ledger under a wallet only.")); continue; }
  console.log(`    knows a reader …${row.reader.slice(-12)}: ${row.freeReadsThisMonth}/${d.free} free reads this month, ${row.paidReads} paid, ${row.wallets.length} wallet${row.wallets.length === 1 ? "" : "s"}`);
  for (const r of row.reads ?? []) console.log(`      ${dim(when(r.at))}  ${r.access.padEnd(4)}  ${titleOf(site, r.slug)}`);
  if ((row.reads ?? []).length === 0) console.log(dim("      (this publisher records counts only; it was deployed before reads were logged)"));
  const bought = d.purchases.filter((p) => p.reader && myReaders.has(p.reader));
  if (bought.length) console.log(dim(`      ledger: ${bought.length} purchase${bought.length === 1 ? "" : "s"} attributed to this pseudonym`));
}
console.log(dim(`\n  Each table is keyed on a different pseudonym. No column joins them; this report could only be assembled here.`));

// ---- 3. what the issuer holds ----
console.log(`\n${bold("What Baselayer holds")}`);
const state = localState(person);
if (!state.verified) {
  console.log(dim("  nothing: this person has not been verified yet"));
} else if (process.env.BASELAYER_API_KEY) {
  const res = await fetch(`${process.env.BASELAYER_API_URL ?? "https://api.baselayer.com"}/issued_credentials?principal_ref=${encodeURIComponent(state.verified.principal_ref)}&limit=200`, { headers: { "X-API-Key": process.env.BASELAYER_API_KEY } });
  const creds = res.ok ? ((await res.json()) as { audience: string; issued_at: string; status: string }[]) : [];
  const byAudience = new Map<string, number>();
  for (const c of creds) byAudience.set(c.audience, (byAudience.get(c.audience) ?? 0) + 1);
  console.log(`  ${person} is a verified person (…${state.verified.principal_ref.slice(-8)}) with ${creds.length} credential${creds.length === 1 ? "" : "s"} minted:`);
  for (const [aud, n] of byAudience) console.log(`    ${aud.padEnd(28)} ${n}`);
  console.log(dim("  It knows which publishers were visited. It does not know a single title, time, or price: credentials are presented to publishers, never routed through the issuer."));
} else {
  console.log(dim("  set BASELAYER_API_KEY to show the issuance records"));
}

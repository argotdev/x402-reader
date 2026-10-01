/**
 * The protocol, step by step. Not the agent (that is ask.ts): this fetches one article,
 * narrates the 402 terms, pays, and prints the receipt, so the exchange is visible.
 *
 *   pnpm read what-x402-actually-does              buy an article by slug
 *   pnpm read https://thedailyagent.news/articles/what-x402-actually-does.md
 *   pnpm read what-x402-actually-does --dry-run    stop at the 402 and show the terms
 *   pnpm read what-x402-actually-does --no-credential   anonymous: no free reads, pay every time
 *   pnpm read --as alice --agent agent-b <slug>    same person, another agent: shares the allowance
 *   pnpm read --as bob <slug>                      a different person: a fresh allowance
 *   pnpm read                                      list what is for sale
 *
 * Env: SITE_URL (default https://thedailyagent.news)
 *      AGENT_PRIVATE_KEY  an EVM key holding USDC on the site's network. Base Sepolia test
 *                         USDC comes from https://faucet.circle.com. Without it the agent
 *                         stops at the 402.
 */
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { Reader } from "./kya.ts";
import { selectPersona } from "./personas.ts";
import { appendHistory } from "./history.ts";

const { selection, rest: args } = await selectPersona(process.argv.slice(2));
const dryRun = args.includes("--dry-run");
const anonymous = selection.anonymous;
const target = args.find((a) => !a.startsWith("--"));
const SITE = (process.env.SITE_URL ?? "https://thedailyagent.news").replace(/\/$/, "");
const KEY = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const say = (s: string) => console.log(s);

const explorers: Record<string, string> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
};

type IndexArticle = { slug: string; title: string; price: string | null; author: string; urls: { markdown: string } };

async function listForSale() {
  const res = await fetch(`${SITE}/articles.json`);
  if (!res.ok) throw new Error(`${SITE}/articles.json answered ${res.status}`);
  const data = (await res.json()) as { payment: { protocol: string }; articles: IndexArticle[] };
  say(bold(`Articles at ${SITE}`));
  for (const a of data.articles) {
    say(`  ${(a.price ?? "free").padEnd(6)} ${a.slug.padEnd(38)} ${dim(a.title)}`);
  }
  if (data.payment.protocol === "none") say(dim("\nThe paywall is off at this site; everything is free."));
  say(dim("\nusage: pnpm read [--as <persona>] [--agent <name>] <slug|url> [--dry-run] [--no-credential]"));
}

function loggingFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const sig = req.headers.get("payment-signature");
    if (sig) {
      const payload = decodePaymentSignatureHeader(sig) as unknown as {
        payload?: { authorization?: { from?: string; to?: string; value?: string; validBefore?: string } };
      };
      const auth = payload.payload?.authorization;
      say(`\n${bold("Signed")} an EIP-3009 authorization${auth ? `: ${auth.value} units from ${short(auth.from)} to ${short(auth.to)}, valid until ${auth.validBefore ? new Date(Number(auth.validBefore) * 1000).toISOString().slice(11, 19) : "?"} UTC` : ""}`);
      say(dim("  Nothing has moved yet. The server hands this to a facilitator to verify and settle."));
    }
    say(`\n${bold("GET")} ${req.url}${sig ? dim("  + PAYMENT-SIGNATURE") : dim("  Accept: text/markdown")}`);
    const started = Date.now();
    const res = await inner(req);
    say(`${bold(String(res.status))} ${res.statusText}  ${dim(`${Date.now() - started} ms`)}`);
    const required = res.headers.get("payment-required");
    if (res.status === 402 && required) {
      const terms = decodePaymentRequiredHeader(required);
      const offer = terms.accepts[0] as unknown as { scheme: string; network: string; amount?: string; asset?: string; payTo?: string; maxTimeoutSeconds?: number };
      say(`  ${dim("PAYMENT-REQUIRED")}  scheme ${offer.scheme}, network ${offer.network}`);
      say(`  ${dim("price           ")}  ${offer.amount} units of ${short(offer.asset)} (USDC, 6 decimals) = $${(Number(offer.amount ?? 0) / 1e6).toFixed(2)}`);
      say(`  ${dim("pay to          ")}  ${offer.payTo}`);
      say(`  ${dim("offer good for  ")}  ${offer.maxTimeoutSeconds}s`);
    }
    return res;
  };
}

function short(s?: string) {
  return s && s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : (s ?? "?");
}

async function main() {
  if (!target) return listForSale();
  const url = target.startsWith("http") ? target : `${SITE}/articles/${target}.md`;

  let doFetch: typeof fetch = loggingFetch(fetch);
  let payer: string | null = null;
  if (KEY && !dryRun) {
    const account = privateKeyToAccount(KEY);
    payer = account.address;
    const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
    doFetch = wrapFetchWithPayment(loggingFetch(fetch), client);
    say(dim(`Paying from ${account.address}`));
  } else {
    say(dim(dryRun ? "Dry run: will stop at the 402." : "No AGENT_PRIVATE_KEY set: will stop at the 402."));
  }

  const headers: Record<string, string> = { accept: "text/markdown" };
  let presentedReader: string | null = null;
  const reader = anonymous ? null : new Reader(selection.person, selection.agent, selection.persona?.name);
  if (reader?.enabled) {
    reader.onEvent = (line) => say(dim(`  ${line}`));
    say(dim(`Reading as ${reader.person} via ${reader.agent}`));
    const presented = await reader.presentation(new URL(url).origin);
    if (presented) {
      presentedReader = presented.reader;
      headers[presented.header] = presented.value;
      say(dim(`  Presenting reader credential …${presented.reader.slice(-8)} with a fresh nonce`));
    } else {
      say(dim("  This publisher does not recognise reader credentials"));
    }
  } else {
    say(dim(anonymous ? "Reading anonymously" : "No BASELAYER_API_KEY: reading anonymously"));
  }

  const res = await doFetch(url, { headers });
  const body = await res.text();
  const receipt = res.headers.get("payment-response");
  const freeReads = res.headers.get("x-free-reads");

  const identity = { person: selection.person, agent: selection.agent, url, reader: presentedReader };
  if (res.status === 200 && freeReads) {
    say(`\n${bold("Free read")} ${freeReads} this month, as a recognised reader. No payment.\n`);
    say(body.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n"));
    await appendHistory({ ...identity, access: "free-read", freeReadsUsed: freeReads });
  } else if (res.status === 401) {
    say(`\n${bold("Credential rejected.")} ${body.slice(0, 300)}`);
  } else if (res.status === 200 && receipt) {
    const r = decodePaymentResponseHeader(receipt);
    const explorer = explorers[String(r.network)];
    say(`\n${bold("Paid.")} ${dim("PAYMENT-RESPONSE")}`);
    say(`  transaction  ${r.transaction}${explorer ? `\n  explorer     ${explorer}${r.transaction}` : ""}`);
    say(`  payer        ${r.payer ?? payer ?? "?"}`);
    say(`  network      ${r.network}`);
    say(`\n${bold("The article")}\n`);
    say(body.split("\n").slice(0, 14).map((l) => `  ${l}`).join("\n"));
    say(dim(`\n  … ${body.split(/\s+/).length} words in total.`));
    const offer = (() => { try { const h = res.headers.get("payment-required"); return h ? (decodePaymentRequiredHeader(h).accepts[0] as unknown as { amount?: string }).amount : undefined; } catch { return undefined; } })();
    await appendHistory({ ...identity, access: "paid", amountAtomic: offer, transaction: r.transaction, network: String(r.network) });
    await checkLedger(r.transaction);
  } else if (res.status === 200) {
    say(`\n${bold("Free.")} No payment was needed.\n`);
    say(body.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n"));
    await appendHistory({ ...identity, access: "free" });
  } else if (res.status === 402) {
    say(`\n${bold("Stopped at the paywall.")}`);
    if (!KEY) say("  Set AGENT_PRIVATE_KEY to a key holding USDC on that network to pay. Test USDC: https://faucet.circle.com");
    else if (dryRun) say("  Run again without --dry-run to pay.");
    else say(`  Payment was attempted but rejected: ${body.slice(0, 300)}`);
  } else {
    say(`\n${res.status}: ${body.slice(0, 300)}`);
  }
}

async function checkLedger(transaction: string) {
  try {
    const res = await fetch(`${SITE}/api/ledger`);
    if (!res.ok) return;
    const ledger = (await res.json()) as { totals: { count: number }; purchases: { transaction: string }[]; store: string };
    const listed = ledger.purchases.some((p) => p.transaction === transaction);
    say(`\n${bold("Ledger")} ${SITE}/ledger`);
    say(`  ${ledger.totals.count} sale${ledger.totals.count === 1 ? "" : "s"} recorded${listed ? ", including this one." : ledger.store === "memory" ? ". This one is not visible: the site is using the in-memory ledger." : ". This one has not appeared yet."}`);
  } catch {
    /* the ledger is a nicety */
  }
}

main().catch((error) => {
  console.error(`\nagent: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

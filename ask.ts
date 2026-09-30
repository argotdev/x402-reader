/**
 * x402-reader: an agent that reads the news for you and pays for what it reads.
 *
 *   pnpm ask "What is the latest on agent payments from http://localhost:3000?"
 *   pnpm ask "Headlines on identity from the Daily Agent today" --budget 0.25
 *   pnpm ask "Summarise https://thedailyagent.news and https://example.com/news on x402"
 *
 * Env: ANTHROPIC_API_KEY   the model
 *      AGENT_PRIVATE_KEY   an EVM key holding USDC; without it, paid articles are declined
 *      SITE_URL            default publication when the request names none
 *
 * Built on the Anthropic SDK's tool runner: the model plans, calls the tools below, and
 * writes the briefing. Payment happens inside read_article, within the run's budget.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Wallet, explorerUrl, usd } from "./paid-fetch.ts";

// ---- arguments -----------------------------------------------------------
const argv = process.argv.slice(2);
const budgetArg = argv.indexOf("--budget");
const budgetUsd = budgetArg >= 0 ? Number(argv[budgetArg + 1]) : 0.5;
const request = argv.filter((a, i) => !a.startsWith("--") && i !== budgetArg + 1).join(" ").trim();
const DEFAULT_SITE = (process.env.SITE_URL ?? "https://thedailyagent.news").replace(/\/$/, "");
const KEY = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;

if (!request) {
  console.error('usage: pnpm ask "<what you want to know, and from which sites>" [--budget 0.50]');
  process.exit(1);
}
if (Number.isNaN(budgetUsd) || budgetUsd < 0) {
  console.error("--budget must be a number of dollars, e.g. --budget 0.25");
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const note = (s: string) => console.error(dim(s));

const wallet = new Wallet(KEY, budgetUsd);

// ---- tools ---------------------------------------------------------------
type IndexArticle = {
  slug: string; title: string; dek: string; author: string; date: string; sectionName: string;
  readingMinutes: number; price: string | null; urls: { html: string; markdown: string };
};

const listPublication = betaZodTool({
  name: "list_publication",
  description:
    "List the articles a publication offers, with titles, summaries, dates, and prices. Works for publications that expose an x402-style index (articles.json or llms.txt), such as The Daily Agent. Call this before reading anything from a site so you can choose what is worth buying. Returns an error message if the site has no such index; use web_fetch for those sites instead.",
  inputSchema: z.object({
    site: z.string().describe("Origin of the publication, e.g. https://thedailyagent.news"),
  }),
  run: async ({ site }) => {
    const origin = site.replace(/\/$/, "");
    note(`  list_publication ${origin}`);
    try {
      const res = await fetch(`${origin}/articles.json`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const data = (await res.json()) as { site: { name: string }; payment?: { protocol: string; network?: string; note?: string }; articles: IndexArticle[] };
        const lines = data.articles.map(
          (a) => `- ${a.title} | ${a.price ?? "free"} | ${a.date} | ${a.sectionName} | ${a.author} | ${a.readingMinutes} min\n  ${a.dek}\n  ${a.urls.markdown}`,
        );
        const payment = data.payment?.protocol === "x402" ? `Paid articles use x402 on ${data.payment.network}. ${data.payment.note ?? ""}` : "All articles are free.";
        return `${data.site.name} (${origin})\n${payment}\n\n${lines.join("\n")}`;
      }
      const llms = await fetch(`${origin}/llms.txt`, { headers: { accept: "text/markdown" } });
      if (llms.ok) return await llms.text();
      return `No article index at ${origin} (articles.json ${res.status}, llms.txt ${llms.status}). Use web_fetch for this site.`;
    } catch (error) {
      return `Could not reach ${origin}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

const readArticle = betaZodTool({
  name: "read_article",
  description:
    "Fetch one article as Markdown. Free articles come back at once. Priced articles are bought over x402 with the reader's wallet, provided the price fits the remaining budget; the result then includes a receipt. If the article cannot be bought (over budget, no wallet), the result says so and you should tell the person rather than retry. Buy only articles that matter for the request.",
  inputSchema: z.object({
    url: z.string().describe("The article's Markdown URL from list_publication, e.g. https://thedailyagent.news/articles/<slug>.md"),
  }),
  run: async ({ url }) => {
    note(`  read_article ${url}`);
    try {
      const { res, terms, receipt, declined } = await wallet.get(url, { accept: "text/markdown" });
      if (declined) {
        note(`    declined: ${declined}`);
        return `Not read. ${declined}.${terms ? ` Price ${usd(terms.amountAtomic)} on ${terms.network}.` : ""} Remaining budget ${usd(wallet.remainingAtomic)}.`;
      }
      if (!res.ok) return `The publisher answered ${res.status} for ${url}.`;
      const text = await res.text();
      const body = text.length > 16000 ? `${text.slice(0, 16000)}\n\n[truncated after 16000 characters]` : text;
      if (receipt) {
        note(`    paid ${usd(receipt.amountAtomic)}  tx ${receipt.transaction.slice(0, 14)}…  remaining ${usd(wallet.remainingAtomic)}`);
        return `[PAID ${usd(receipt.amountAtomic)}. transaction ${receipt.transaction} on ${receipt.network}${explorerUrl(receipt) ? `, ${explorerUrl(receipt)}` : ""}. Remaining budget ${usd(wallet.remainingAtomic)}.]\n\n${body}`;
      }
      note("    free");
      return `[FREE]\n\n${body}`;
    } catch (error) {
      return `Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

const walletStatus = betaZodTool({
  name: "wallet",
  description: "The reader's spending position for this run: budget, spent so far, remaining, receipts, and whether a wallet is configured at all.",
  inputSchema: z.object({}),
  run: async () => {
    note("  wallet");
    const balance = await wallet.usdcBalance();
    return JSON.stringify(
      {
        configured: wallet.address !== null,
        address: wallet.address,
        usdcBalance: balance?.display ?? (wallet.address ? "unknown" : null),
        note: balance && balance.atomic === 0n ? "The wallet holds no USDC, so no purchase can settle until it is funded." : undefined,
        budget: usd(wallet.budgetAtomic),
        spent: usd(wallet.spentAtomic),
        remaining: usd(wallet.remainingAtomic),
        receipts: wallet.receipts.map((r) => ({ url: r.url, amount: usd(r.amountAtomic), transaction: r.transaction, explorer: explorerUrl(r) })),
      },
      null,
      2,
    );
  },
});

// ---- the agent -----------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const system = `You are a news reader working for one person. They tell you what they want to know and, usually, which publications to read. You find the relevant articles, read them, and write a briefing.

Today is ${today}. If the request names no publication, use ${DEFAULT_SITE}.

How to work:
- For each publication, call list_publication first. It shows every article with its date, summary, and price, so you can pick what is relevant before spending anything. Only if a site has no index, fall back to web_fetch on the pages the person named, or web_search if they gave a topic without sites.
- Read what the request actually needs. Prefer free articles when they cover the topic. Buy a priced article only when it clearly matters, and never buy the same article twice. The read_article tool enforces the budget; if it declines a purchase, do not retry it. Report the reason it gave in the briefing, and if the wallet holds no USDC say plainly that it needs funding.
- Read articles in parallel when you have chosen several.

The briefing:
- Lead with the headlines that answer the request, newest first, each with a one- or two-sentence summary of what the article actually says, the publication, the date, and a link. Plain prose, no marketing tone.
- If something relevant was not read because of budget or a missing wallet, say what it was and what it would have cost.
- End with a short "Spent" section: total spent against the budget, and one line per purchase with the amount and the transaction link. If nothing was bought, say so in one line.`;

const client = new Anthropic();

const startingBalance = await wallet.usdcBalance();
note(`Budget ${usd(wallet.budgetAtomic)}${wallet.address ? `, paying from ${wallet.address}${startingBalance ? ` (holds ${startingBalance.display} USDC on Base Sepolia)` : ""}` : ", no wallet: paid articles will be declined"}`);
if (startingBalance && startingBalance.atomic === 0n) note("The wallet has no USDC. Fund it at https://faucet.circle.com (Base Sepolia) or purchases will be refused.");
note(`Asking claude-opus-5…\n`);

const runner = client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 16000,
  max_iterations: 30,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system,
  tools: [
    listPublication,
    readArticle,
    walletStatus,
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  ],
  messages: [{ role: "user", content: request }],
});

const textOf = (content: Anthropic.Beta.BetaContentBlock[]) =>
  content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");

for await (const message of runner) {
  // Progress: what the model says between tool calls, and which tools it reaches for.
  if (message.stop_reason !== "end_turn") {
    const said = textOf(message.content).trim();
    if (said) note(said);
  }
  for (const block of message.content) {
    if (block.type === "tool_use") note(`→ ${block.name}`);
    if (block.type === "server_tool_use") note(`→ ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
  }
  // Server tools can pause a long turn; the runner only resumes after a client tool result.
  if (message.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: message.content });
}

const final = await runner.done();

if (final.stop_reason === "refusal") {
  console.error(`\nThe model declined this request${final.stop_details?.explanation ? `: ${final.stop_details.explanation}` : "."}`);
  process.exit(2);
}
if (final.stop_reason === "max_tokens") note("\n(The briefing was cut off by max_tokens.)");

console.log("");
console.log(textOf(final.content).trim());

console.log("");
console.log(dim(`${bold("Spent")} ${usd(wallet.spentAtomic)} of ${usd(wallet.budgetAtomic)} across ${wallet.receipts.length} purchase${wallet.receipts.length === 1 ? "" : "s"}. ${final.usage.input_tokens + final.usage.output_tokens} tokens on the final turn.`));

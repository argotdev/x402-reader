# x402-reader

An agent that reads the news for you and pays for what it reads.

You tell it what you want to know and which publications to read. It lists what each one offers, picks the relevant articles, buys the priced ones over [x402](https://x402.org) within a budget you set, and writes a briefing with links and receipts. It shares no code with any publisher; everything it knows, it learns over HTTP.

Built as the reader half of [The Daily Agent](https://thedailyagent.news) demo. The agent loop is the Anthropic SDK's tool runner running `claude-opus-5`; the tools are three small functions in `ask.ts`.

## Run it

First time? [SETUP.md](SETUP.md) goes from nothing to a paid read: wallets, test USDC, the network, the publisher's configuration.

```bash
pnpm install
cp .env.example .env     # ANTHROPIC_API_KEY, AGENT_PRIVATE_KEY, SITE_URL

pnpm ask "What is the latest on agent payments from https://thedailyagent.news?"
pnpm ask "Headlines on identity from the Daily Agent today" --budget 0.25
pnpm ask "Compare what https://thedailyagent.news and https://example.com/news say about x402"
```

`--budget` caps spending for the run in dollars (default 0.50). Without `AGENT_PRIVATE_KEY` the agent still runs, reads everything free, and tells you what it could not buy and for how much.

Progress goes to stderr (which tool is running, what was paid); the briefing goes to stdout, so `pnpm ask "..." > briefing.md` works.

## What it does

1. **Discovers.** For each publication named in the request it calls `list_publication`, which reads the site's `articles.json` (or `llms.txt`): every article with date, summary, section, and price. Sites without an index are read with Anthropic's web fetch tool instead.
2. **Chooses.** The model picks what answers the request, preferring free articles when they cover it and buying priced ones only when they matter.
3. **Reads and pays.** `read_article` fetches the Markdown. On a 402 it checks the price against the remaining budget, signs an EIP-3009 authorization for exactly that amount, retries with `PAYMENT-SIGNATURE`, and records the receipt from `PAYMENT-RESPONSE`. Over budget or no wallet: it declines and says so.
4. **Briefs.** Headlines newest first with a summary of what each article says, publication, date, and link. Then what was not read and why. Then a "Spent" section with the total and one transaction link per purchase.

Refusal fallbacks are on: if the model declines a request on policy grounds the API reruns it on a fallback model inside the same call.

## The protocol, step by step

`pnpm read` is the low-level companion: no model, one article, every header printed.

```bash
pnpm read                                    # list what is for sale
pnpm read what-x402-actually-does --dry-run  # stop at the 402 and print the terms
pnpm read what-x402-actually-does            # pay and read
```

## Helpers

```bash
pnpm keygen                 # a fresh test key: prints address and private key once
pnpm balance [0xAddress]    # USDC and ETH balance on Base Sepolia
```

## Files

```
ask.ts          the agent: system prompt, three tools, the tool-runner loop
paid-fetch.ts   Wallet: a fetch that pays 402s within a budget and keeps receipts
read.ts         the narrated single-article client
keygen.ts       test key generator
balance.ts      USDC balance check
SETUP.md        from nothing to a paid read
```

## Next

Hold a reader credential and present it alongside the payment, so a publisher that recognises the reader can apply a free allowance without learning who they are.

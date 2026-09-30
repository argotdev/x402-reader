# x402-reader

A reader that is a program. It asks a publisher for an article as Markdown, meets the 402, pays over [x402](https://x402.org), and prints the receipt, narrating each step. It shares no code with the publisher; everything it knows, it learns from HTTP.

Built as the reader half of [The Daily Agent](https://thedailyagent.news) demo, but any x402 publisher works for full URLs.

## Run it

```bash
pnpm install
cp .env.example .env        # set SITE_URL and, to pay, AGENT_PRIVATE_KEY

pnpm read                                    # list what is for sale
pnpm read what-x402-actually-does --dry-run  # stop at the 402 and print the terms
pnpm read what-x402-actually-does            # pay and read
pnpm read https://thedailyagent.news/articles/a-wallet-is-not-a-reader.md
SITE_URL=http://localhost:3000 pnpm read what-x402-actually-does   # against a local publisher
```

`AGENT_PRIVATE_KEY` is an EVM key holding USDC on the publisher's network. The Daily Agent settles on Base Sepolia while in test; get test USDC from [Circle's faucet](https://faucet.circle.com). Without a key the reader stops at the 402 and shows how to fund one.

## What it prints

```
GET https://thedailyagent.news/articles/what-x402-actually-does.md  Accept: text/markdown
402 Payment Required  14 ms
  PAYMENT-REQUIRED  scheme exact, network eip155:84532
  price             100000 units of 0x036CbD…CF7e (USDC, 6 decimals) = $0.10
  pay to            0x…
  offer good for    120s

Signed an EIP-3009 authorization: 100000 units from 0x… to 0x…, valid until 14:03:11 UTC
  Nothing has moved yet. The server hands this to a facilitator to verify and settle.

GET https://thedailyagent.news/articles/what-x402-actually-does.md  + PAYMENT-SIGNATURE
200 OK  1840 ms

Paid. PAYMENT-RESPONSE
  transaction  0x…
  explorer     https://sepolia.basescan.org/tx/0x…
  payer        0x…
  network      eip155:84532

The article
  # What x402 actually does
  ...

Ledger https://thedailyagent.news/ledger
  1 sale recorded, including this one.
```

## How it works

One file, `agent.ts`. The x402 client from `@x402/fetch` wraps `fetch`: on a 402 it reads the terms from `PAYMENT-REQUIRED`, has the EVM scheme sign an EIP-3009 authorization for exactly that amount, and retries with `PAYMENT-SIGNATURE`. A logging wrapper around `fetch` prints each request and decodes the headers so the exchange is visible. The slug shortcut, the listing, and the ledger check assume The Daily Agent's layout; a full URL to any x402 resource skips all three.

## Next

Hold a reader credential and present it alongside the payment, so a publisher that recognises the reader can apply a free allowance without learning who they are.

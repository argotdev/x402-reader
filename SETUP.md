# Setup: a real paid read on Base Sepolia

This walks from nothing to an agent buying an article from The Daily Agent with test USDC, then a person doing the same through the paywall page in a browser. Everything here is on a test network. No real money is involved and no key created here should ever hold any.

Two projects are involved. The **publisher** is the site, in `../thedailyagent`. The **reader** is this project.

## 0. Tools

- Node 24 or later and pnpm 11 or later. Check with `node --version` and `pnpm --version`.
- A browser wallet for the human test in step 7: Coinbase Wallet, MetaMask, or Rabby. Not needed for the agent.

## 1. The network

Both sides settle on **Base Sepolia**, Base's public test network.

| | |
| --- | --- |
| Chain id | 84532 |
| CAIP-2 id (used in x402 config) | `eip155:84532` |
| Public RPC | `https://sepolia.base.org` |
| Explorer | `https://sepolia.basescan.org` |
| USDC contract | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Nothing needs to be installed for the agent to use it. For a browser wallet, add the network in step 7.

Nobody in this flow needs ETH. x402 payments are signed authorizations (EIP-3009) that the facilitator submits and pays gas for. The reader only needs USDC.

## 2. Two wallets

You need two addresses: one that receives money (the publisher) and one that spends it (the reader). Generate them here:

```bash
pnpm install
pnpm keygen     # run twice: once for the reader, once for the publisher
```

Each run prints an address and a private key, once, and saves nothing. Copy them somewhere safe such as a password manager.

- **Reader key**: the whole `AGENT_PRIVATE_KEY=0x…` line goes into this project's `.env` in step 4.
- **Publisher address**: only the *address* is needed, as `PAY_TO` in step 5. Keep its key if you ever want to move the test USDC it collects; otherwise it can be discarded.

If you would rather receive into a wallet you already have, use that wallet's address for `PAY_TO` and skip the second keygen.

## 3. Test USDC for the reader

1. Open <https://faucet.circle.com>.
2. Choose **Base Sepolia** as the network.
3. Paste the **reader's address** (not the key) and request. Circle sends 10 USDC per request and rate limits repeat requests, so one is plenty: at 5¢ to 25¢ an article that is dozens of reads.
4. Confirm it arrived:

```bash
AGENT_PRIVATE_KEY=0x… pnpm balance      # or just: pnpm balance 0xReaderAddress
```

You should see `USDC 10`. It can take a minute.

## 4. Configure the reader

```bash
cp .env.example .env
```

Edit `.env`:

```
SITE_URL=http://localhost:3000
AGENT_PRIVATE_KEY=0x…        # the reader key from step 2
```

`.env` is gitignored. Check with `git status` that it does not appear.

## 5. Configure and start the publisher

In `../thedailyagent`:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```
NEXT_PUBLIC_SITE_URL=http://localhost:3000
PAY_TO=0x…                                     # the publisher address from step 2
X402_NETWORK=eip155:84532
X402_FACILITATOR_URL=https://x402.org/facilitator
```

The facilitator is the service that verifies each signed payment and submits it to the chain. The one above is the public testnet facilitator run by the x402 project. It is free and needs no account. It does not work on mainnet; see step 9.

Optionally add a ledger store now (step 6). Then:

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. Paid articles now show a price after their byline (10¢, 5¢, 25¢). Open one in the browser and you should see the paywall page rather than the article.

## 6. The ledger store (optional locally, required for a deployment)

The site records each sale in Redis. Without it the sale still settles, but locally the ledger page may not show it because the in-memory fallback is not shared between the proxy and the pages.

Two ways to get an Upstash Redis database:

- **Instant, no account**: `curl -X POST https://upstash.com/start-redis`. The response contains a REST URL and token. Databases made this way are for trying things out, not for keeping.
- **With an account**: <https://console.upstash.com>, create a Redis database, copy the REST URL and token from its page. The free tier is enough. On Vercel, the Upstash Marketplace integration creates one and sets the variables for you under the `KV_REST_API_*` names, which the site also accepts.

Add to the publisher's `.env.local` and restart `pnpm dev`:

```
UPSTASH_REDIS_REST_URL=https://….upstash.io
UPSTASH_REDIS_REST_TOKEN=…
```

## 7. The paid read

With the publisher running, from this project:

```bash
pnpm read                                         # what is for sale, with prices
pnpm read what-x402-actually-does --dry-run       # the 402 and its terms, no payment
pnpm read what-x402-actually-does                 # pay 10¢ and read
```

A successful run prints the terms from the 402, the authorization it signed, the 200, and a receipt block with a transaction hash and an explorer link. Check three things:

1. **The receipt** in the terminal has a `transaction` and `payer` matching the reader address.
2. **The explorer link** opens a transaction on Sepolia Basescan showing 0.1 USDC transferred from the reader address to `PAY_TO`. The transaction sender will be the facilitator, which is expected: it submitted the authorization and paid the gas.
3. **The ledger** at <http://localhost:3000/ledger> shows the sale, if a store is configured. `pnpm balance` should now show 9.9 USDC.

Read the same article again and you pay again. x402 has no memory of past payments; that is what the reader credential will add later.

## 8. The human test: pay in the browser

The paywall page carries a wallet widget for people. To try it:

1. Add Base Sepolia to your browser wallet. In MetaMask: Settings, Networks, Add network, with chain id `84532`, RPC `https://sepolia.base.org`, symbol `ETH`, explorer `https://sepolia.basescan.org`. Coinbase Wallet: enable testnets in Settings, then pick Base Sepolia. Rabby has it built in.
2. Import the USDC token so you can see the balance: token address `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
3. Fund that wallet's address from the Circle faucet as in step 3. You need no ETH.
4. Open a paid article at <http://localhost:3000>, choose your wallet in the widget, connect, and approve. The wallet asks you to sign a message (an EIP-3009 authorization), not to send a transaction. The page then reloads as the article.
5. The sale appears on the ledger like any other.

## 9. Before pointing at a real network

Not for now, but so the differences are known:

- Switch `X402_NETWORK` to `eip155:8453` (Base mainnet). The USDC contract there is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and the reader picks it up from the 402 terms automatically.
- The public x402.org facilitator is testnet only. Mainnet needs a production facilitator such as Coinbase's, which requires a Coinbase Developer Platform account and API keys, or another operator listed in the x402 ecosystem docs.
- Use wallets whose keys you would trust with real money, which rules out anything printed to a terminal by `pnpm keygen`.
- Set `NEXT_PUBLIC_SITE_URL` to the real origin and use a persistent Upstash database.

## Troubleshooting

**`402` after the agent tried to pay.** The body says why. Usually the reader has no USDC on that network (`pnpm balance`), or the reader and publisher disagree on the network. Both should say `eip155:84532`.

**`502` with a facilitator error.** The facilitator is unreachable or rejected the request. Check `X402_FACILITATOR_URL` and that the network is one it supports; the public one supports Base Sepolia.

**The ledger is empty after a successful read.** No store configured (step 6), or the site was not restarted after adding the variables.

**`Another next dev server is already running.`** Next allows one dev server per directory. `pkill -f "next dev"` and start again.

**`.env not found. Continuing without it.`** Node's note that there is no `.env` in this project. Harmless; create one (step 4) or pass variables inline.

**The paywall page shows but the widget cannot find my wallet.** The widget looks for a browser extension wallet. Mobile wallets over WalletConnect are not wired up in this build.

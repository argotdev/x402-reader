# x402-reader

An agent that reads the news for you and pays for what it reads.

You tell it what you want to know and which publications to read. It lists what each one offers, picks the relevant articles, takes the free reads it is entitled to as a recognised reader, buys the rest over [x402](https://x402.org) within a budget you set, and writes a briefing with links and receipts. It shares no code with any publisher; everything it knows, it learns over HTTP.

It has an identity as well as a wallet. The person behind it is verified once with [Baselayer](https://docs.baselayer.com/docs/kya-overview), and for each publisher the agent mints a short-lived credential naming that person by a pseudonym that is stable at that publisher and unrelated to the one used anywhere else. Publishers that recognise it grant a free allowance per person, however many agents the person sends. Publishers see a pseudonym and counts, never who the person is.

Built as the reader half of [The Daily Agent](https://thedailyagent.news) demo. The agent loop is the Anthropic SDK's tool runner running `claude-opus-5`; the tools are three small functions in `ask.ts`.

## Run it

First time? [SETUP.md](SETUP.md) goes from nothing to a paid read: wallets, test USDC, the network, the publisher's configuration. Presenting? [DEMO.md](DEMO.md) is the run of show, and `PERSON=<fresh-name> pnpm demo` drives the command-line acts.

```bash
pnpm install
cp .env.example .env     # ANTHROPIC_API_KEY, AGENT_PRIVATE_KEY, BASELAYER_API_KEY, SITE_URL

pnpm ask "What is the latest on agent payments from https://thedailyagent.news?"
pnpm ask "Headlines on identity from the Daily Agent today" --budget 0.25
pnpm ask "Compare what https://thedailyagent.news and https://example.com/news say about x402"
```

`--budget` caps spending for the run in dollars (default 0.50). Without `AGENT_PRIVATE_KEY` the agent still runs, reads everything free, and tells you what it could not buy and for how much. `--no-credential` reads anonymously: no free reads, pay for everything. Without `BASELAYER_API_KEY` it is anonymous too.

Progress goes to stderr (which tool is running, what was paid); the briefing goes to stdout, so `pnpm ask "..." > briefing.md` works.

## What it does

1. **Discovers.** For each publication named in the request it calls `list_publication`, which reads the site's `articles.json` (or `llms.txt`): every article with date, summary, section, and price. Sites without an index are read with Anthropic's web fetch tool instead.
2. **Chooses.** The model picks what answers the request, preferring free articles when they cover it and buying priced ones only when they matter.
3. **Identifies, reads, pays.** `read_article` fetches the Markdown. If the publisher publishes a `kya-profile.json`, the request carries the reader's credential and a key binding JWT over a nonce the publisher just issued; a free read comes back with `X-Free-Reads: n/3`. Otherwise, on a 402 it checks the price against the remaining budget, signs an EIP-3009 authorization for exactly that amount, retries with `PAYMENT-SIGNATURE`, and records the receipt from `PAYMENT-RESPONSE`. Over budget or no wallet: it declines and says so.
4. **Briefs.** Headlines newest first with a summary of what each article says, publication, date, and link. Then what was not read and why. Then a "Spent" section: free reads taken, total spent, and one transaction link per purchase.

Refusal fallbacks are on: if the model declines a request on policy grounds the API reruns it on a fallback model inside the same call.

## The protocol, step by step

`pnpm read` is the low-level companion: no model, one article, every header printed.

```bash
pnpm read                                    # list what is for sale
pnpm read what-x402-actually-does --dry-run  # stop at the 402 and print the terms
pnpm read what-x402-actually-does            # free read if the allowance allows, else pay
pnpm read what-x402-actually-does --no-credential   # anonymous: pay
```

The identity scenario, one person with two agents:

```bash
PERSON=alice pnpm read what-x402-actually-does                    # free read 1/3
PERSON=alice AGENT_NAME=agent-b pnpm read a-wallet-is-not-a-reader # a different key, same person: 2/3
PERSON=alice pnpm read who-settles-a-ten-cent-payment             # 3/3
PERSON=alice pnpm read three-free-reads-without-a-login           # allowance used: pays 25¢
PERSON=bob pnpm read what-x402-actually-does                      # another person: a fresh allowance
```

The publisher's `/readers` page shows one row for alice with three free reads and one paid, whichever agent made them, and one row for bob.

The same person at a second publisher, [The Delegate](../thedelegate), gets a fresh allowance and an identifier that shares nothing with the first:

```bash
SITE_URL=http://localhost:3001 PERSON=alice pnpm read whose-side-is-your-agent-on   # free read 1/2, new identifier
```

The cached credentials in `.kya/agents/<agent>/credentials/alice/` show both identifiers side by side: same issuer prefix, then nothing in common.

## Personas

`personas.json` is a roster of invented people and the agents they send. Pick one with `--as`, and an agent with `--agent`; without flags the reader acts for `PERSON` (default alice) through that persona's first agent.

```bash
pnpm ask --as bob "..."                        # a different person: own allowances, unrelated identifiers
pnpm read --as alice --agent agent-b <slug>    # the same person through another agent: one allowance
pnpm read --as demo-oct1 <slug>                # any name works; a suffix on a roster name inherits its details
pnpm personas                                  # every persona: verification, agents, identifiers, and what each publisher knows
```

`pnpm personas` matches each persona's identifiers against the readers tables of the publishers in `PUBLISHERS` (default: both demo sites), so you can see, per person, per site: free reads used, paid reads, wallets. No names cross that line in either direction.

## The issuer's view

`pnpm baselayer` shows what Baselayer holds for this organisation. Needs `BASELAYER_API_KEY`; the console at <https://console.baselayer.com> shows the same, once the environment switch is set to Sandbox.

```bash
pnpm baselayer people                          # everyone verified, with the local persona name where known
pnpm baselayer person alice                    # one identity: state, attributes, submissions, credentials
pnpm baselayer credentials --person alice      # issuance records; also --audience, --state ACTIVE|EXPIRED|REVOKED
pnpm baselayer audit alice                     # the append-only log: registration, issuances, revocations
pnpm baselayer revoke <jti>                    # kill a credential
pnpm baselayer issuer                          # the public DID document, signing key, status list
```

Revocation is the demo's twist: revoke a persona's credential, and on the next read the publisher refuses it as `REVOKED` (it checks the issuer's status list, which updates within a few minutes) and the reader mints a fresh one.

## Helpers

```bash
pnpm keygen                 # a fresh test key: prints address and private key once
pnpm balance [0xAddress]    # USDC and ETH balance on Base Sepolia
```

## Files

```
ask.ts          the agent: system prompt, three tools, the tool-runner loop
personas.ts     the roster, --as/--agent parsing, and the pnpm personas listing
baselayer.ts    the issuer's view: people, credentials, audit log, revocation
paid-fetch.ts   Wallet: a fetch that identifies itself, takes free reads, pays 402s within a budget, keeps receipts
kya.ts          Reader: the Baselayer identity, agent key, per-publisher credentials, key binding
read.ts         the narrated single-article client
.kya/           local state: people/<person>.json, agents/<agent>/key.json, agents/<agent>/credentials/<person>/<audience>.json (gitignored)
keygen.ts       test key generator
balance.ts      USDC balance check
SETUP.md        from nothing to a paid read
```

## Next

Run the two-publisher scenario against a second deployment, so the unlinkability of the identifiers is visible side by side.

# Demo: a reader that pays and is recognised

Two publishers, one reader, about fifteen minutes. Everything runs from this directory against the live sites. The command-line acts are also in `demo.sh`, which pauses between steps.

- **The Daily Agent** <https://www.thedailyagent.news>: a broadsheet of explainers, 5¢ to 25¢, three free reads a month.
- **The Delegate** <https://www.thedelegate.tech>: a magazine of reportage and essays, 50¢ to $1, two free reads a month.
- **x402-reader**: the agent. Pays over x402, carries a Baselayer reader credential.

## Before you start

1. `.env` here has `ANTHROPIC_API_KEY`, `AGENT_PRIVATE_KEY`, `BASELAYER_API_KEY`, and `SITE_URL=https://www.thedailyagent.news`.
2. The reader wallet holds test USDC: `pnpm balance`. Ten cents' worth of articles per act; a dollar covers the whole demo.
3. **Pick a fresh person for this run**, for example `export PERSON=demo-oct1` with today's date. Free reads are counted per person per month, so a name that has already been used will start with its allowance spent. A new name costs nothing: the first read verifies a fixture identity in the Baselayer sandbox. `pnpm personas` shows who has been used and what each publisher knows about them.
4. Open in browser tabs, in this order: Daily Agent front page, Delegate front page, Daily Agent `/ledger`, Daily Agent `/readers`, Delegate `/readers`, and a Sepolia Basescan tab.
5. Credentials live one hour. If a demo runs long the agent re-mints on its own.

## Act 1. Two publications for people (browser)

Show both front pages. Point out the price beside each byline and the "For agents" link in the masthead. Open a priced piece on either site: the paywall page, with the article's headline, the price, and a wallet widget. A person can pay here; the rest of the demo is about programs.

Point to make: these are ordinary publications. Nothing about them requires an agent.

## Act 2. The same publications for programs

```bash
curl -s https://www.thedailyagent.news/llms.txt | head -20
pnpm read
```

The index lists every article with its price, so a program can decide before it asks. Then the 402 itself, anonymously:

```bash
pnpm read what-x402-actually-does --no-credential --dry-run
```

Read the terms aloud: scheme, network, amount in USDC units, the publisher's address, how long the offer stands. That header is the whole price tag.

Point to make: HTTP has had this status code since 1997. The header is what was missing.

## Act 3. Paying

```bash
pnpm read what-x402-actually-does --no-credential
```

Watch the sequence: 402, the signed authorization (nothing has moved yet), the retry, 200 with a receipt. Open the explorer link: 0.10 USDC from the reader to the publisher, submitted by the facilitator. Refresh the Daily Agent ledger: a new row, payer shown, reader "anonymous".

Point to make: no account, no card, no session. The receipt is the transaction. And the publisher knows only a wallet address, which is the problem the next act solves.

## Act 4. Being recognised

Same publisher, now carrying a credential. The first run verifies the person and mints.

```bash
pnpm read a-wallet-is-not-a-reader              # verifies PERSON, mints, free read 1/3
AGENT_NAME=agent-b pnpm read who-settles-a-ten-cent-payment   # a different key: free read 2/3
pnpm read three-free-reads-without-a-login      # free read 3/3
pnpm read what-x402-actually-does               # allowance spent: pays, attributed to the reader
```

Refresh the Daily Agent readers page: one row, a pseudonym, three free reads, one paid, two wallets if agent-b paid from a different key. Refresh the ledger: the last sale names the reader.

Points to make: two agents, two keys, one person, one allowance. The publisher sees a pseudonym and counts. It never learned a name, and it verified the credential against a public key document without an account at the issuer.

## Act 5. The second publisher

```bash
SITE_URL=https://www.thedelegate.tech pnpm read whose-side-is-your-agent-on   # fresh allowance: free read 1/2
cat .kya/agents/agent-a/credentials/$PERSON/*.json | grep '"sub"'
```

Two identifiers for the same person. Same issuer prefix, then nothing in common. Put the two readers pages side by side: one row each, and no column that joins them.

Point to make: stable where the reader wants continuity, unlinkable where they do not. A wallet address and an email address both fail this test.

## Act 5b. The issuer's side

```bash
pnpm baselayer people                 # the fixture people, including today's
pnpm baselayer audit $PERSON          # registration, then one issuance per publisher
pnpm personas                         # the same person as each publisher sees them
```

Point to make: three parties, three views. The issuer knows who the person is and which publishers it minted for, not what they read. Each publisher knows what an anonymous regular read, not who they are. The reader holds the only keys.

Optional twist, if there is time: `pnpm baselayer revoke <jti>` on one of today's credentials, wait a few minutes for the status list, and read again. The publisher refuses with `REVOKED` and the agent mints afresh.

## Act 6. The agent

Now the whole thing at once, from a sentence:

```bash
pnpm ask "What are https://www.thedailyagent.news and https://www.thedelegate.tech saying about reader identity and who an agent works for? Read what matters." --budget 1.50
```

Narrate the progress lines: it lists both publications, chooses, takes whatever free reads remain, buys the rest one at a time within the budget, and writes a briefing that ends with what it did not read and why, and a Spent section with free reads and transaction links. Refresh both ledgers.

Points to make: the person asked a question. Discovery, choice, identity, payment, and citation happened underneath. The budget was the only control they set.

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| First read pays instead of being free | `PERSON` already used this month. Pick a new name. |
| `payment attempted but publisher answered 402` with a USDC balance of 0 | Fund the reader at <https://faucet.circle.com>, Base Sepolia. |
| Two parallel purchases fail, then succeed on retry | Old build. Pull; payments are serialised now. |
| Credential rejected with `AUDIENCE_MISMATCH` | The site's advertised audience changed since the credential was cached. Delete `.kya/agents/*/credentials/$PERSON/` and rerun. |
| The agent goes to the wrong site | Name the sites by URL in the request. |
| Baselayer console looks empty | Switch its environment dropdown to Sandbox; the key in `.env` is a sandbox key. |
| Explorer shows the transaction but the ledger does not | Refresh; settlement and the ledger write are a second or two apart. |

## Resetting between demos

- New `PERSON` name: fresh allowances everywhere, no cleanup needed.
- To clear a reader from a publisher's table, delete `reader:<did>` and remove it from `readers:all` in that site's Upstash database.
- Ledgers are append-only by design. A demo leaves rows; that is fine, they are the point.

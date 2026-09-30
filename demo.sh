#!/usr/bin/env bash
# The command-line acts of DEMO.md, with a pause between steps.
#   PERSON=demo-oct ./demo.sh
set -euo pipefail
cd "$(dirname "$0")"
DA=${DA_URL:-https://www.thedailyagent.news}
DG=${DG_URL:-https://www.thedelegate.tech}
: "${PERSON:?Set PERSON to a fresh name for this run, e.g. PERSON=demo-oct ./demo.sh}"
export PERSON
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pause() { printf '\n\033[2m[enter to continue]\033[0m'; read -r; }

bold "Act 2. What is for sale at The Daily Agent"
SITE_URL=$DA pnpm -s read
pause
bold "The 402, anonymously (dry run)"
SITE_URL=$DA pnpm -s read what-x402-actually-does --no-credential --dry-run
pause

bold "Act 3. Paying, anonymously"
SITE_URL=$DA pnpm -s read what-x402-actually-does --no-credential
pause

bold "Act 4. Being recognised: $PERSON via agent-a"
SITE_URL=$DA pnpm -s read a-wallet-is-not-a-reader
pause
bold "Same person, another agent (agent-b)"
SITE_URL=$DA AGENT_NAME=agent-b pnpm -s read who-settles-a-ten-cent-payment
pause
bold "Third free read"
SITE_URL=$DA pnpm -s read three-free-reads-without-a-login
pause
bold "Allowance spent: this one pays, attributed to the reader"
SITE_URL=$DA pnpm -s read what-x402-actually-does
pause

bold "Act 5. The second publisher: a fresh allowance and a new identifier"
SITE_URL=$DG pnpm -s read whose-side-is-your-agent-on
bold "The two identifiers for $PERSON"
grep -h '"sub"' .kya/agents/agent-a/credentials/"$PERSON"/*.json || true
pause

bold "Act 6. The agent"
SITE_URL=$DA pnpm -s ask "What are $DA and $DG saying about reader identity and who an agent works for? Read what matters." --budget 1.50

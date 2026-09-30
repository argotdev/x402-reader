/**
 * A fetch that pays, and that says who is asking. Wraps the x402 client so that a 402 is paid
 * automatically, but only within a per-run budget, and keeps the receipts. When the publisher
 * recognises reader credentials and this reader has one, the request carries it first, so a
 * free read is taken before any money moves.
 */
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { Reader } from "./kya.ts";

export type Receipt = {
  url: string;
  amountAtomic: bigint;
  transaction: string;
  network: string;
  payer: string;
};

export type Terms = { amountAtomic: bigint; network: string; payTo: string; asset: string };

const EXPLORERS: Record<string, string> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
};
const CHAINS = { "eip155:8453": base, "eip155:84532": baseSepolia } as const;
const USDC: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const usd = (atomic: bigint) => `$${(Number(atomic) / 1e6).toFixed(2)}`;
export const explorerUrl = (r: Receipt) => (EXPLORERS[r.network] ? `${EXPLORERS[r.network]}${r.transaction}` : null);

export type FreeRead = { url: string; reader: string; used: string };

export class Wallet {
  readonly address: string | null;
  readonly budgetAtomic: bigint;
  spentAtomic = 0n;
  readonly receipts: Receipt[] = [];
  readonly freeReads: FreeRead[] = [];
  /** The reader identity presented to publishers; null means anonymous. */
  readonly reader: Reader | null;
  private payingFetch: typeof fetch | null = null;
  // Payments run one at a time. Concurrent settlements from the same payer were refused
  // by the facilitator in testing; serialising them costs a second or two and removes the retries.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(privateKey: `0x${string}` | undefined, budgetUsd: number, reader: Reader | null = null) {
    this.budgetAtomic = BigInt(Math.round(budgetUsd * 1e6));
    this.reader = reader && reader.enabled ? reader : null;
    if (privateKey) {
      const account = privateKeyToAccount(privateKey);
      this.address = account.address;
      const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
      this.payingFetch = wrapFetchWithPayment(fetch, client);
    } else {
      this.address = null;
    }
  }

  get remainingAtomic() {
    return this.budgetAtomic - this.spentAtomic;
  }

  /** On-chain USDC balance on a network, or null if the network is unknown or unreachable. */
  async usdcBalance(network: string = "eip155:84532"): Promise<{ atomic: bigint; display: string } | null> {
    const chain = CHAINS[network as keyof typeof CHAINS];
    const token = USDC[network];
    if (!this.address || !chain || !token) return null;
    try {
      const client = createPublicClient({ chain, transport: http() });
      const atomic = await client.readContract({
        address: token,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [this.address as Address],
      });
      return { atomic, display: `$${formatUnits(atomic, 6)}` };
    } catch {
      return null;
    }
  }

  /** The publisher's stated reason for a 402, from the PAYMENT-REQUIRED header or the body. */
  static async reason(res: Response): Promise<string | null> {
    const header = res.headers.get("payment-required");
    try {
      if (header) {
        const required = decodePaymentRequiredHeader(header) as { error?: string };
        if (required.error && required.error !== "Payment required") return required.error;
      }
      const body = (await res.clone().json()) as { error?: string; errorReason?: string; message?: string };
      return body.errorReason ?? body.error ?? body.message ?? null;
    } catch {
      return null;
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Decode the price from a 402 without paying. */
  static terms(res: Response): Terms | null {
    const header = res.headers.get("payment-required");
    if (!header) return null;
    const required = decodePaymentRequiredHeader(header);
    const offer = required.accepts[0] as unknown as { amount?: string; network?: string; payTo?: string; asset?: string };
    if (!offer?.amount) return null;
    return { amountAtomic: BigInt(offer.amount), network: offer.network ?? "?", payTo: offer.payTo ?? "?", asset: offer.asset ?? "?" };
  }

  /**
   * GET a URL. Free resources come straight back. If the publisher recognises readers and this
   * wallet has an identity, the request carries a credential and a free read is taken when one
   * is left. Otherwise a 402 is paid if a wallet is present and the price fits the remaining
   * budget; if not, the 402 is returned as-is with `terms` set.
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<{ res: Response; terms: Terms | null; receipt: Receipt | null; declined: string | null; freeRead: FreeRead | null }> {
    // Identify, if the publisher accepts it.
    const origin = new URL(url).origin;
    let presented: { header: string; value: string; reader: string } | null = null;
    if (this.reader) {
      for (let attempt = 0; attempt < 2 && !presented; attempt++) {
        try {
          presented = await this.reader.presentation(origin);
        } catch (error) {
          this.reader.onEvent(`Could not present a credential to ${origin}: ${error instanceof Error ? error.message : String(error)}${attempt === 0 ? "; trying once more" : "; reading anonymously"}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    if (presented) headers = { ...headers, [presented.header]: presented.value };

    let first = await fetch(url, { headers });

    // The publisher would not accept the credential (expired, revoked, rotated key): mint afresh once.
    if (first.status === 401 && presented && this.reader) {
      const why = await first.clone().json().catch(() => ({})) as { code?: string };
      this.reader.onEvent(`Credential rejected (${why.code ?? first.status}); minting a fresh one`);
      try {
        presented = await this.reader.presentation(origin, true);
        if (presented) {
          headers = { ...headers, [presented.header]: presented.value };
          first = await fetch(url, { headers });
        }
      } catch (error) {
        return { res: first, terms: null, receipt: null, declined: `credential rejected and re-mint failed: ${error instanceof Error ? error.message : String(error)}`, freeRead: null };
      }
    }

    if (first.status === 200 && presented && first.headers.get("x-free-reads")) {
      const freeRead = { url, reader: presented.reader, used: first.headers.get("x-free-reads")! };
      this.freeReads.push(freeRead);
      return { res: first, terms: null, receipt: null, declined: null, freeRead };
    }
    if (first.status !== 402) return { res: first, terms: null, receipt: null, declined: null, freeRead: null };

    const terms = Wallet.terms(first);
    if (!terms) return { res: first, terms: null, receipt: null, declined: "402 without readable x402 terms", freeRead: null };
    if (!this.payingFetch) return { res: first, terms, receipt: null, declined: "no wallet configured (AGENT_PRIVATE_KEY)", freeRead: null };
    if (terms.amountAtomic > this.remainingAtomic) {
      return { res: first, terms, receipt: null, declined: `price ${usd(terms.amountAtomic)} exceeds remaining budget ${usd(this.remainingAtomic)}`, freeRead: null };
    }

    const paid = await this.serial(() => this.payingFetch!(url, { headers }));
    const header = paid.headers.get("payment-response");
    if (paid.status !== 200 || !header) {
      const reason = paid.status === 402 ? await Wallet.reason(paid) : null;
      const balance = await this.usdcBalance(terms.network);
      const funds = balance ? ` The wallet holds ${balance.display} USDC on ${terms.network}.` : "";
      return {
        res: paid,
        terms,
        receipt: null,
        declined: `payment attempted but publisher answered ${paid.status}${reason ? ` (${reason})` : ""}.${funds}`,
        freeRead: null,
      };
    }
    const settled = decodePaymentResponseHeader(header);
    const receipt: Receipt = {
      url,
      amountAtomic: terms.amountAtomic,
      transaction: settled.transaction,
      network: String(settled.network),
      payer: settled.payer ?? this.address ?? "?",
    };
    this.spentAtomic += terms.amountAtomic;
    this.receipts.push(receipt);
    return { res: paid, terms, receipt, declined: null, freeRead: null };
  }
}

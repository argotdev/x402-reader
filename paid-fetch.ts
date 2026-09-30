/**
 * A fetch that pays. Wraps the x402 client so that a 402 is paid automatically, but only
 * within a per-run budget, and keeps the receipts.
 */
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";

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

export const usd = (atomic: bigint) => `$${(Number(atomic) / 1e6).toFixed(2)}`;
export const explorerUrl = (r: Receipt) => (EXPLORERS[r.network] ? `${EXPLORERS[r.network]}${r.transaction}` : null);

export class Wallet {
  readonly address: string | null;
  readonly budgetAtomic: bigint;
  spentAtomic = 0n;
  readonly receipts: Receipt[] = [];
  private payingFetch: typeof fetch | null = null;

  constructor(privateKey: `0x${string}` | undefined, budgetUsd: number) {
    this.budgetAtomic = BigInt(Math.round(budgetUsd * 1e6));
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
   * GET a URL. Free resources come straight back. A 402 is paid if a wallet is present and
   * the price fits the remaining budget; otherwise the 402 is returned as-is with `terms` set.
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<{ res: Response; terms: Terms | null; receipt: Receipt | null; declined: string | null }> {
    const first = await fetch(url, { headers });
    if (first.status !== 402) return { res: first, terms: null, receipt: null, declined: null };

    const terms = Wallet.terms(first);
    if (!terms) return { res: first, terms: null, receipt: null, declined: "402 without readable x402 terms" };
    if (!this.payingFetch) return { res: first, terms, receipt: null, declined: "no wallet configured (AGENT_PRIVATE_KEY)" };
    if (terms.amountAtomic > this.remainingAtomic) {
      return { res: first, terms, receipt: null, declined: `price ${usd(terms.amountAtomic)} exceeds remaining budget ${usd(this.remainingAtomic)}` };
    }

    const paid = await this.payingFetch(url, { headers });
    const header = paid.headers.get("payment-response");
    if (paid.status !== 200 || !header) {
      return { res: paid, terms, receipt: null, declined: `payment attempted but publisher answered ${paid.status}` };
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
    return { res: paid, terms, receipt, declined: null };
  }
}

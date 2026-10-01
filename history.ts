/**
 * The reader's own record of what it read: the one place where "this person read these pieces
 * on these sites" can be assembled, because only the reader knows which pseudonym is theirs where.
 *
 * One JSON line per read in .kya/history/<person>.jsonl.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.env.KYA_STORE ?? ".kya");

export type HistoryEntry = {
  at: string;
  person: string;
  agent: string;
  url: string;
  access: "free" | "free-read" | "paid";
  freeReadsUsed?: string; // "2/3"
  amountAtomic?: string;
  transaction?: string;
  network?: string;
  reader: string | null; // the pseudonym presented, if any
};

export async function appendHistory(entry: Omit<HistoryEntry, "at">): Promise<void> {
  const file = path.join(ROOT, "history", `${entry.person}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export async function readHistory(person: string): Promise<HistoryEntry[]> {
  try {
    const text = await readFile(path.join(ROOT, "history", `${person}.jsonl`), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}

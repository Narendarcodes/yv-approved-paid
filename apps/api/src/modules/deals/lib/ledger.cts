/**
 * Append-only money ledger. Each entry carries the hash of the previous entry
 * for the same deal, so editing or deleting any past line breaks the chain and
 * verifyChain() reports where. The Mongo model (models.cts) also refuses
 * updates and deletes; this file is the pure part.
 */
const { hashOf } = require('./canonical.cts');

export type LedgerType =
  | 'authorize'
  | 'reauthorize'
  | 'capture'
  | 'partial_capture'
  | 'void'
  | 'refund'
  | 'payout'
  | 'invoice'
  | 'blocked'
  | 'pending_approval'
  | 'webhook'
  | 'state';

export type LedgerEntry = {
  dealId: string;
  orgId: string;
  milestoneKey: string;
  seq: number;
  type: LedgerType;
  /** Money that actually moved (or was held) in this step; 0 for blocked/pending/state lines. */
  amountMinor: number;
  currency: string;
  moved: boolean;
  paypalRef?: string;
  idempotencyKey?: string;
  actor: string;
  /** Plain-language reason shown on the money timeline. Built from templates and numbers, never by a model. */
  explanation: string;
  policy?: { allowed: boolean; violations: { rule: string; message: string }[] };
  at: string;
  prevHash: string;
  hash: string;
};

const GENESIS = '0'.repeat(64);

function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return hashOf({ ...e });
}

function nextEntry(prev: LedgerEntry | null, data: Omit<LedgerEntry, 'seq' | 'prevHash' | 'hash'>): LedgerEntry {
  const base = { ...data, seq: prev ? prev.seq + 1 : 1, prevHash: prev ? prev.hash : GENESIS };
  return { ...base, hash: entryHash(base) };
}

function verifyChain(entries: LedgerEntry[]): { ok: boolean; brokenAt?: number; reason?: string } {
  let prevHash = GENESIS;
  let seq = 0;
  for (const e of entries) {
    seq += 1;
    if (e.seq !== seq) return { ok: false, brokenAt: e.seq, reason: `expected seq ${seq}` };
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: e.seq, reason: 'prevHash mismatch' };
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return { ok: false, brokenAt: e.seq, reason: 'entry content changed' };
    prevHash = hash;
  }
  return { ok: true };
}

/** Totals that the UI and the reconciliation test read. */
function totals(entries: LedgerEntry[]) {
  const sum = (t: LedgerType) => entries.filter((e) => e.type === t && e.moved).reduce((a, e) => a + e.amountMinor, 0);
  return {
    heldMinor: sum('authorize'),
    capturedMinor: sum('capture') + sum('partial_capture'),
    refundedMinor: sum('refund'),
    paidOutMinor: sum('payout'),
    invoicedMinor: sum('invoice'),
    blockedCount: entries.filter((e) => e.type === 'blocked').length,
  };
}

module.exports = { nextEntry, verifyChain, totals, GENESIS, entryHash };

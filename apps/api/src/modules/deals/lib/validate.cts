/** Validation of deal terms before anyone can sign them. Returns a list of problems (empty = valid). */
import type { DealTerms } from './types.cts';

const KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function validateTerms(t: DealTerms): string[] {
  const p: string[] = [];
  if (!t || typeof t !== 'object') return ['terms missing'];
  if (!t.title || typeof t.title !== 'string') p.push('title is required');
  if (!/^[A-Z]{3}$/.test(t.currency || '')) p.push('currency must be an ISO code like USD');
  for (const side of ['client', 'worker'] as const) {
    const party = t[side];
    if (!party || !party.userId || !party.displayName) p.push(`${side} party needs userId and displayName`);
    else if (party.role !== side) p.push(`${side} party has role ${party.role}`);
  }
  if (t.client && t.worker && t.client.userId === t.worker.userId) p.push('client and worker must be different people');
  if (!Array.isArray(t.milestones) || t.milestones.length === 0) p.push('at least one milestone');
  const keys = new Set<string>();
  for (const m of t.milestones || []) {
    const at = `milestone ${m.key}`;
    if (!KEY.test(m.key || '')) p.push(`${at}: key must be lowercase letters, digits, _ or -`);
    if (keys.has(m.key)) p.push(`${at}: duplicate key`);
    keys.add(m.key);
    if (!m.title) p.push(`${at}: title is required`);
    if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor <= 0) p.push(`${at}: amount must be typed by a person as a positive amount`);
    if (Number.isNaN(Date.parse(m.dueAt))) p.push(`${at}: dueAt must be a date`);
    for (const [k, v] of [['graceHours', m.graceHours], ['reviewWindowHours', m.reviewWindowHours], ['revisionRoundsIncluded', m.revisionRoundsIncluded]] as const) {
      if (!Number.isInteger(v) || v < 0) p.push(`${at}: ${k} must be a whole number >= 0`);
    }
    if (m.reviewWindowHours !== undefined && m.reviewWindowHours < 1) p.push(`${at}: review window must be at least 1 hour`);
    const ids = new Set<string>();
    for (const c of m.checklist || []) {
      if (!c.id || ids.has(c.id)) p.push(`${at}: checklist ids must be unique and present`);
      ids.add(c.id);
      if (c.kind !== 'check' && c.kind !== 'taste') p.push(`${at}: checklist ${c.id} kind must be check or taste`);
      if (c.kind === 'check' && !c.measure) p.push(`${at}: checklist ${c.id} is a check but has no measure`);
    }
    const shares = (m.payees || []).reduce((a, x) => a + (Number.isInteger(x.shareBp) ? x.shareBp : NaN), 0);
    if (!m.payees || m.payees.length === 0) p.push(`${at}: at least one payee`);
    else if (shares !== 10000) p.push(`${at}: payee shares must add up to 100% (got ${shares / 100}%)`);
    for (const x of m.payees || []) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email || '')) p.push(`${at}: payee email ${x.email} is not valid`);
  }
  for (const r of t.rateCard || []) {
    if (!r.id || !r.label) p.push('rate card items need id and label');
    if (!Number.isSafeInteger(r.unitPriceMinor) || r.unitPriceMinor <= 0) p.push(`rate card ${r.id}: price must be positive`);
  }
  if (!Number.isInteger(t.killFeeBp) || t.killFeeBp < 0 || t.killFeeBp > 10000) p.push('kill fee must be 0-100%');
  if (!Number.isSafeInteger(t.humanApprovalThresholdMinor) || t.humanApprovalThresholdMinor < 0) p.push('human approval threshold must be >= 0');
  return p;
}

module.exports = { validateTerms };

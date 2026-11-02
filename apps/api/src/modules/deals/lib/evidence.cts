/**
 * Check evidence screenshots (the Video QA agent's frames) for LiveChecksCard.
 *
 *   evidenceDir()                 DEALS_EVIDENCE_DIR (shared with the agent), default <cwd>/uploads/deal-evidence
 *   referencedNames(deal)         file names the deal's stored check results point at
 *   resolveEvidence(deal, name)   absolute path of a file that may be served, or null
 *
 * A file is served only when ALL hold: its name matches a strict pattern (no
 * slashes, no "..", image extension only), a stored check result of THIS deal
 * names it, and the real path (symlinks resolved) is inside the evidence dir.
 * The agent may write frames flat or under <dir>/<dealId>/; both are looked up.
 */
import type { DealDoc } from './types.cts';

const fs = require('node:fs');
const path = require('node:path');

/** e.g. loud_002.40.jpg (checklist id, timestamp, extension) */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}(?:\.[0-9]{1,4}){0,2}\.(?:jpg|jpeg|png|webp)$/;
const DEAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function evidenceDir(): string {
  return path.resolve(process.env.DEALS_EVIDENCE_DIR || path.join(process.cwd(), 'uploads', 'deal-evidence'));
}

function isEvidenceName(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name);
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function referencedNames(deal: DealDoc): Set<string> {
  const out = new Set<string>();
  for (const m of deal.milestones || []) {
    for (const v of m.versions || []) {
      for (const r of v.checks?.results || []) {
        for (const e of r.evidence || []) {
          const b = typeof e.screenshot === 'string' ? basenameOf(e.screenshot) : '';
          if (isEvidenceName(b)) out.add(b);
        }
      }
    }
  }
  return out;
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The file to serve for `name` on this deal, or null (the route answers 404 for every null). */
function resolveEvidence(deal: DealDoc, name: unknown, dir = evidenceDir()): string | null {
  if (!isEvidenceName(name) || !referencedNames(deal).has(name)) return null;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(dir);
  } catch {
    return null;
  }
  const candidates = [...(DEAL_ID.test(deal.id) ? [path.join(dir, deal.id, name)] : []), path.join(dir, name)];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (!inside(path.resolve(dir), abs)) continue;
    try {
      const real = fs.realpathSync(abs);
      if (!inside(realRoot, real)) continue;
      if (!fs.statSync(real).isFile()) continue;
      return real;
    } catch {
      /* not there; try the next place */
    }
  }
  return null;
}

module.exports = { evidenceDir, isEvidenceName, referencedNames, resolveEvidence };

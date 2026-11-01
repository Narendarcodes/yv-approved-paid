/**
 * Canonical JSON (sorted keys, no whitespace) and SHA-256 hashing. The signed
 * deal terms are locked by this hash: any later change to an amount, a
 * deadline or a checklist line changes the hash, and the policy engine refuses
 * money moves against terms whose hash no longer matches the signatures.
 */
const crypto = require('node:crypto');

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashOf(value: unknown): string {
  return sha256(canonicalize(value));
}

module.exports = { canonicalize, sha256, hashOf };

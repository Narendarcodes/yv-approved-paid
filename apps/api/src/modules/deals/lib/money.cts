/**
 * Money is integer minor units (cents) everywhere inside the module. Strings
 * like "400.00" exist only at the PayPal boundary. No floats ever touch an
 * amount, so 0.1 + 0.2 problems cannot reach a capture.
 */

export type Currency = string; // ISO 4217, e.g. "USD"

const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

function decimalsFor(currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/** "400.00" -> 40000. Throws on anything that is not a plain non-negative decimal. */
function toMinor(value: string | number, currency: Currency): number {
  const s = String(value).trim();
  const d = decimalsFor(currency);
  const re = d === 0 ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(s)) throw new Error(`invalid amount "${s}" for ${currency}`);
  const [whole, frac = ''] = s.split('.');
  const minor = Number(whole) * 10 ** d + Number((frac + '00').slice(0, d) || '0');
  if (!Number.isSafeInteger(minor)) throw new Error('amount out of range');
  return minor;
}

/** 40000 -> "400.00" */
function toMajor(minor: number, currency: Currency): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`invalid minor amount ${minor}`);
  const d = decimalsFor(currency);
  if (d === 0) return String(minor);
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** Human form for explanations: "$400.00", "₹2,500.00", "EUR 10.00". */
function format(minor: number, currency: Currency): string {
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', AUD: 'A$', CAD: 'C$' };
  const major = toMajor(minor, currency);
  const [w, f] = major.split('.');
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = f !== undefined ? `${grouped}.${f}` : grouped;
  return sym[currency] ? `${sym[currency]}${body}` : `${currency} ${body}`;
}

/** Percentage of an amount in basis points (1% = 100 bp), rounded half-up to the minor unit. */
function percentOf(minor: number, basisPoints: number): number {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new Error(`invalid basis points ${basisPoints}`);
  }
  return Math.floor((minor * basisPoints + 5000) / 10000);
}

module.exports = { toMinor, toMajor, format, percentOf, decimalsFor };

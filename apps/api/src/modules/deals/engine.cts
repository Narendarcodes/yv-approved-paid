/**
 * deals/engine: the pure deal core (no database, no HTTP).
 *
 *   states     lifecycle table + transition()
 *   policy     evaluate(deal, action, ctx) -> allowed / violations / needsHumanApproval
 *   engine     human events (sign, submit, approve, ...) and the Money Agent (plan, execute, tick)
 *   ledger     hash-chained entries + verifyChain + totals
 *   money      minor-unit helpers
 *   split      splitCents: a release split into crew shares (integer cents, leftover to the lead)
 */
const states = require('./lib/states.cts');
const policy = require('./lib/policy.cts');
const engine = require('./lib/engine.cts');
const ledger = require('./lib/ledger.cts');
const money = require('./lib/money.cts');
const { hashOf, canonicalize } = require('./lib/canonical.cts');
const { validateTerms } = require('./lib/validate.cts');
const { explain } = require('./lib/explain.cts');
const proposals = require('./lib/proposals.cts');
const split = require('./lib/split.cts');
const receipts = require('./lib/receipts.cts');

export type * from './lib/types.cts';
export type { LedgerEntry } from './lib/ledger.cts';
export type { PaymentGateway } from './lib/gateway.cts';
export type { EngineDeps, LedgerStore, ExecOutcome } from './lib/engine.cts';
export type { PolicyContext } from './lib/policy.cts';

module.exports = { states, policy, engine, ledger, money, proposals, split, receipts, hashOf, canonicalize, validateTerms, explain };

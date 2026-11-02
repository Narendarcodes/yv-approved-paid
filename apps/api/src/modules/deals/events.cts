/**
 * deals/events: in-process notifications from the deal module.
 *
 *   onLedgerAppend(fn)   fn(entry) after every ledger line is written; returns an unsubscribe
 *   emitLedgerAppend(e)  called by the ledger store (internal)
 *
 * The realtime layer subscribes and pushes each entry to the Socket.IO room
 * `deal:<id>`, which a socket joins only after an org-access check. A failing
 * listener never breaks a money step: the entry is already written.
 */
import type { LedgerEntry } from './lib/ledger.cts';

const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

function onLedgerAppend(fn: (entry: LedgerEntry) => void): () => void {
  const safe = (e: LedgerEntry) => {
    try {
      fn(e);
    } catch {
      /* listeners are best-effort */
    }
  };
  bus.on('ledger', safe);
  return () => bus.off('ledger', safe);
}

function emitLedgerAppend(entry: LedgerEntry): void {
  bus.emit('ledger', entry);
}

module.exports = { onLedgerAppend, emitLedgerAppend };

---
status: accepted (reaffirms ADR-0008 "no second database")
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# MongoDB stays the only database of record, so no Postgres for billing, clicks or analytics

We considered adding Postgres for Invoices and Contracts, affiliate Clicks and the analytics time-series. We decided against it.

- Invoices and Contracts are low-volume, single-document records with no cross-row money movement.
- Clicks are append-only events, which fit a MongoDB time-series collection with a TTL.
- Performance Series is an idempotent daily upsert (ADR-0009), which fits a regular collection with a unique key.

A second database would double backups, migrations, local and CI services and failure modes for a solo developer, and nothing in the domain needs a relational join that MongoDB can't serve.

The rules that make this safe:
- Run MongoDB as a **replica set**, even a single node, or Atlas. That gives transactions and change streams. The compose file's standalone `mongo:7` provides neither.
- Store money as integer minor units plus currency (`amountMinor`). Today `amount` is a float (`models/invoice.model.js`, `models/contract.model.js`).
- Make the invoice number unique per Organization with a counter document.

## Revisit when
- yv. starts moving money: affiliate commission payouts to many creators, or agency billing with credits and partial payments. That needs a ledger. Use a payment provider's ledger first, and Postgres only if that falls short.
- Cross-tenant ad-hoc reporting outgrows MongoDB aggregations. Reach for a columnar store (ClickHouse or DuckDB on exports), not Postgres.

Note: self-hosted Postiz brings its own Postgres. That database belongs to Postiz. yv. never reads from it or writes to it.

## Decisions recorded on acceptance (2026-10-25)
- Q20: yv. will not collect payments or pay out affiliate commissions for the next 6 months, so the trigger for revisiting this ADR is not met.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.

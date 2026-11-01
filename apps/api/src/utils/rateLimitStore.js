/**
 * Rate-limit counter stores (Phase 1 item 9).
 *
 * Store interface (all methods async so a networked store fits unchanged):
 *   hit(key, windowMs)  -> { count, resetAt: Date }   increment, start a fixed
 *                                                     window on the first hit
 *   get(key)            -> { count, resetAt } | null  read without counting
 *   decrement(key)      -> void                       refund one hit (e.g. a
 *                                                     successful login)
 *   reset(key)          -> void
 *   clear()             -> void                       forget all counters
 *
 * MemoryStore is per-process: fine for one API instance. With several
 * instances behind a load balancer each keeps its own counters (limits become
 * N x looser), so swap in a RedisStore with the same interface
 * (INCR + PEXPIRE NX on first hit, PTTL for resetAt, DECR, DEL).
 */
class MemoryStore {
  constructor({ sweepMs = 60 * 1000 } = {}) {
    this.map = new Map();
    // Drop expired windows so the map does not grow with every IP/email seen.
    this.timer = setInterval(() => this.sweep(), sweepMs);
    if (this.timer.unref) this.timer.unref();
  }

  live(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.resetAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  async hit(key, windowMs) {
    let e = this.live(key);
    if (!e) {
      e = { count: 0, resetAt: Date.now() + windowMs };
      this.map.set(key, e);
    }
    e.count += 1;
    return { count: e.count, resetAt: new Date(e.resetAt) };
  }

  async get(key) {
    const e = this.live(key);
    return e ? { count: e.count, resetAt: new Date(e.resetAt) } : null;
  }

  async decrement(key) {
    const e = this.live(key);
    if (e && e.count > 0) e.count -= 1;
  }

  async reset(key) {
    this.map.delete(key);
  }

  /** Forget every counter (tests, admin unlock). */
  async clear() {
    this.map.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.resetAt <= now) this.map.delete(k);
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { MemoryStore };

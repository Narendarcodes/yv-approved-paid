/**
 * Agent routing: primary deal agent (Render) with an automatic fallback (Azure VM),
 * plus a Render free-hours budget the API keeps in Mongo.
 *
 * Routing (makeAgentRouter):
 *   - Tries AGENT_URL first. A network error, a timeout or a 502/503/504 retries the
 *     same request once on AGENT_FALLBACK_URL and caches "primary down" for
 *     AGENT_DOWN_CACHE_MS (default 5 min), so later requests go straight to the fallback.
 *   - When the month's Render hour budget is spent, every call goes to the fallback
 *     until the next UTC month.
 *   - With no fallback configured it behaves exactly like a single fetch to AGENT_URL.
 *
 * Budget (makeHourBudget), run from the API's own tick (startAgentTick, every 4 min):
 *   - Counts the API's own uptime (the API is awake whenever it ticks) and Render-agent
 *     warm time (each successful API -> agent /health ping = one tick of warm time) per
 *     UTC calendar month, in the `render_hours` collection. Partial minutes round UP.
 *   - RENDER_HOURS_SEED="YYYY-MM:hours" adds hours Render already counted before this
 *     tracker started (read off the Render billing page).
 *   - RENDER_HOURS_PROJECT (default on) also adds the API's own hours still to come this
 *     month (it is kept awake 24/7), so the switch happens early enough that the month
 *     total, API included, stays under RENDER_HOURS_SWITCH. Set RENDER_HOURS_PROJECT=0
 *     to switch on hours already used only.
 *   - At RENDER_HOURS_SWITCH (default 700) it stops pinging the Render agent and routes
 *     all agent calls to the fallback until the next UTC month. The switch is sticky.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7); // UTC YYYY-MM
}

function monthEndMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** "2026-11:23.5" (also "2026-11=23.5") -> { month: '2026-11', hours: 23.5 } */
function parseSeed(raw) {
  const m = /^\s*(\d{4}-\d{2})\s*[:=]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(raw || ''));
  return m ? { month: m[1], hours: Number(m[2]) } : null;
}

/** Mongo store (one doc per UTC month). Tests pass an in-memory store with the same shape. */
function mongoStore(getDb) {
  const col = () => getDb().collection('render_hours');
  return {
    async inc(month, fields) {
      await col().updateOne(
        { _id: month },
        { $inc: fields, $set: { updatedAt: new Date() } },
        { upsert: true },
      );
    },
    async get(month) {
      return col().findOne({ _id: month });
    },
    async markSwitched(month, at) {
      await col().updateOne(
        { _id: month, switchedAt: { $exists: false } },
        { $set: { switchedAt: at } },
        { upsert: false },
      );
    },
  };
}

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async inc(month, fields) {
      const d = docs.get(month) || { _id: month };
      for (const [k, v] of Object.entries(fields)) d[k] = (d[k] || 0) + v;
      docs.set(month, d);
    },
    async get(month) {
      return docs.get(month) || null;
    },
    async markSwitched(month, at) {
      const d = docs.get(month) || { _id: month };
      if (!d.switchedAt) d.switchedAt = at;
      docs.set(month, d);
    },
  };
}

function makeHourBudget({
  store,
  now = () => Date.now(),
  switchHours = 700,
  project = true,
  seed = null,
  startedAt = now(),
  agentTailMin = 15, // a free Render instance stays up ~15 min after its last request
} = {}) {
  let lastTickAt = startedAt;
  let status = null;

  function seedFor(month) {
    return seed && seed.month === month ? seed.hours : 0;
  }

  function summarize(doc, t) {
    const month = monthKey(t);
    const apiHours = (doc?.apiMin || 0) / 60;
    const agentHours = (doc?.agentMin || 0) / 60;
    const seedHours = seedFor(month);
    const used = seedHours + apiHours + agentHours;
    const apiRemaining = project ? Math.max(0, (monthEndMs(t) - t) / HOUR) : 0;
    const over = !!doc?.switchedAt || used + apiRemaining >= switchHours;
    return {
      month,
      hoursCounted: round2(used),
      apiHours: round2(apiHours),
      agentHours: round2(agentHours),
      seedHours: round2(seedHours),
      projectedApiHoursLeft: project ? round2(apiRemaining) : null,
      switchAt: switchHours,
      overBudget: over,
      switchedAt: doc?.switchedAt ? new Date(doc.switchedAt).toISOString() : null,
    };
  }

  return {
    /** Count the API's uptime since the last tick (rounded up to whole minutes). */
    async countApi() {
      const t = now();
      const minutes = Math.max(1, Math.ceil((t - lastTickAt) / MIN));
      lastTickAt = t;
      await store.inc(monthKey(t), { apiMin: minutes });
      return minutes;
    },
    async countAgent(minutes) {
      await store.inc(monthKey(now()), { agentMin: Math.ceil(minutes) });
    },
    /** Reads the month, makes the sticky switch when the budget is reached. */
    async evaluate() {
      const t = now();
      const month = monthKey(t);
      let doc = await store.get(month);
      let s = summarize(doc, t);
      let switchedNow = false;
      if (s.overBudget && !doc?.switchedAt) {
        // the agent stays warm a while after the last ping: count that tail before switching
        await store.inc(month, { agentMin: agentTailMin });
        await store.markSwitched(month, new Date(t));
        doc = await store.get(month);
        s = summarize(doc, t);
        switchedNow = true;
      }
      status = s;
      return { ...s, switchedNow };
    },
    status() {
      // a month rollover un-switches at once, even before the next tick
      if (status && status.month !== monthKey(now())) return null;
      return status;
    },
    overBudget() {
      const s = this.status();
      return !!(s && s.overBudget);
    },
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

const RETRYABLE = new Set([502, 503, 504]);

/**
 * getTargets() -> { primary, fallback } (read on every call, so config changes apply).
 * isOverBudget() -> true routes everything to the fallback.
 */
function makeAgentRouter({
  getTargets,
  isOverBudget = () => false,
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  downMs = 5 * MIN,
  log = null,
  primaryName = 'render',
  fallbackName = 'azure',
} = {}) {
  const downUntil = new Map(); // primary url -> ms

  function targets() {
    const { primary, fallback } = getTargets();
    const p = primary ? String(primary).replace(/\/+$/, '') : '';
    const f = fallback ? String(fallback).replace(/\/+$/, '') : '';
    return { p, f: f && f !== p ? f : '' };
  }

  function isDown(p) {
    return (downUntil.get(p) || 0) > now();
  }

  function markDown(p, why) {
    const wasDown = isDown(p);
    downUntil.set(p, now() + downMs);
    if (!wasDown && log)
      log.warn(
        { primary: primaryName, why, forMs: downMs },
        `agent ${primaryName} down -> ${fallbackName}`,
      );
  }

  function markUp(p) {
    if (isDown(p) || downUntil.has(p)) {
      downUntil.delete(p);
      if (log) log.info({ primary: primaryName }, `agent ${primaryName} back up`);
    }
  }

  function plan() {
    const { p, f } = targets();
    if (f && isOverBudget()) return [{ url: f, name: fallbackName, why: 'budget' }];
    if (f && isDown(p)) return [{ url: f, name: fallbackName, why: 'primary_down' }];
    const out = [{ url: p, name: primaryName, primary: true }];
    if (f) out.push({ url: f, name: fallbackName });
    return out;
  }

  /**
   * fetch(path, init, { attemptTimeoutMs, signal }) -> { res, agent }
   * attemptTimeoutMs bounds each attempt until response headers arrive.
   * Throws (err.timedOut, err.agent) when every target failed at the network level.
   */
  async function fetchAgent(path, init = {}, { attemptTimeoutMs = 15_000, signal } = {}) {
    const steps = plan();
    let lastErr = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const last = i === steps.length - 1;
      if (signal?.aborted) break;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, attemptTimeoutMs);
      try {
        const res = await fetchImpl(`${step.url}${path}`, { ...init, signal: ac.signal });
        clearTimeout(timer);
        if (RETRYABLE.has(res.status) && !last) {
          if (step.primary) markDown(step.url, `http_${res.status}`);
          if (log)
            log.warn({ from: step.name, status: res.status, path }, 'agent call failed over');
          continue;
        }
        if (step.primary && res.status < 500) markUp(step.url);
        return { res, agent: step.name };
      } catch (err) {
        clearTimeout(timer);
        if (signal?.aborted && !timedOut)
          throw Object.assign(err || new Error('aborted'), { timedOut: false, agent: step.name });
        lastErr = Object.assign(
          new Error(timedOut ? 'agent timeout' : (err && err.message) || 'agent unreachable'),
          {
            timedOut,
            agent: step.name,
          },
        );
        if (step.primary) markDown(step.url, timedOut ? 'timeout' : 'network');
        if (!last && log) log.warn({ from: step.name, timedOut, path }, 'agent call failed over');
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
    throw lastErr || Object.assign(new Error('aborted'), { timedOut: false });
  }

  return {
    fetch: fetchAgent,
    markDown: (why) => markDown(targets().p, why),
    markUp: () => markUp(targets().p),
    active() {
      const { p, f } = targets();
      if (f && isOverBudget()) return fallbackName;
      if (f && isDown(p)) return fallbackName;
      return primaryName;
    },
    primaryDownUntil() {
      const t = downUntil.get(targets().p) || 0;
      return t > now() ? new Date(t).toISOString() : null;
    },
    hasFallback: () => !!targets().f,
  };
}

/** One API tick: count uptime, evaluate the budget, ping the Render agent while under it. */
async function runTick({
  budget,
  router,
  getTargets,
  fetchImpl = (...a) => globalThis.fetch(...a),
  pingTimeoutMs = 8000,
  tickMin = 4,
  log = null,
}) {
  await budget.countApi();
  const s = await budget.evaluate();
  if (s.switchedNow && log)
    log.warn(
      { month: s.month, hoursCounted: s.hoursCounted, switchAt: s.switchAt },
      'render hour budget reached: agent -> fallback until next UTC month',
    );
  const { primary, fallback } = getTargets();
  let pinged = false;
  if (!s.overBudget && primary) {
    // Over budget (with or without a fallback) the Render agent is never pinged.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), pingTimeoutMs);
    try {
      const r = await fetchImpl(`${String(primary).replace(/\/+$/, '')}/health`, {
        signal: ac.signal,
      });
      if (r.ok) {
        await budget.countAgent(tickMin);
        router.markUp();
        pinged = true;
      } else if (fallback) router.markDown(`health_${r.status}`);
    } catch {
      // A timed-out ping usually means a cold start this request just triggered: the agent
      // comes up and stays warm anyway, so count the tick (count up, never down).
      if (ac.signal.aborted) await budget.countAgent(tickMin);
      if (fallback) router.markDown(ac.signal.aborted ? 'health_timeout' : 'health_unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...budget.status(), pinged };
}

/* ------------------------------------------------------------- singleton (app) */

let singleton = null;
function agentRouting() {
  if (singleton) return singleton;
  const config = require('../config');
  const env = process.env;
  const getTargets = () => ({ primary: config.agent.url, fallback: config.agent.fallbackUrl });
  const budget = makeHourBudget({
    store: mongoStore(() => require('mongoose').connection.db),
    switchHours: Number(env.RENDER_HOURS_SWITCH || 700),
    project: env.RENDER_HOURS_PROJECT !== '0',
    seed: parseSeed(env.RENDER_HOURS_SEED),
    startedAt: Date.now() - Math.ceil(process.uptime() * 1000),
  });
  let log = null;
  try {
    log = require('../utils/logger');
  } catch {
    log = null;
  }
  const router = makeAgentRouter({
    getTargets,
    isOverBudget: () => budget.overBudget(),
    downMs: Number(env.AGENT_DOWN_CACHE_MS || 5 * MIN),
    log,
  });
  singleton = { budget, router, getTargets, timer: null, lastTick: null };
  return singleton;
}

function startAgentTick(log = console) {
  const s = agentRouting();
  const every = Number(process.env.AGENT_TICK_MS || 4 * MIN);
  if (s.timer || process.env.NODE_ENV === 'test' || every <= 0) return;
  let running = false;
  const once = async () => {
    if (running) return;
    running = true;
    try {
      s.lastTick = await runTick({
        budget: s.budget,
        router: s.router,
        getTargets: s.getTargets,
        tickMin: Math.ceil(every / MIN),
        log,
      });
    } catch (err) {
      log.error({ err: err && err.message }, 'agent tick failed');
    } finally {
      running = false;
    }
  };
  once();
  s.timer = setInterval(once, every);
  s.timer.unref?.();
}

/** Read-only snapshot for GET /api/v1/health. */
function agentStatus() {
  const s = agentRouting();
  const b = s.budget.status();
  return {
    active: s.router.active(),
    fallbackConfigured: s.router.hasFallback(),
    primaryDownUntil: s.router.primaryDownUntil(),
    hours: b
      ? {
          month: b.month,
          counted: b.hoursCounted,
          api: b.apiHours,
          agent: b.agentHours,
          seed: b.seedHours,
          projectedApiLeft: b.projectedApiHoursLeft,
          switchAt: b.switchAt,
          overBudget: b.overBudget,
          switchedAt: b.switchedAt,
        }
      : null,
    lastPingOk: s.lastTick ? !!s.lastTick.pinged : null,
  };
}

module.exports = {
  monthKey,
  monthEndMs,
  parseSeed,
  memoryStore,
  mongoStore,
  makeHourBudget,
  makeAgentRouter,
  runTick,
  agentRouting,
  startAgentTick,
  agentStatus,
};

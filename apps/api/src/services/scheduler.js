/**
 * Background loop that drives the scheduling service: publishes due local
 * posts, polls Postiz, refreshes metrics. One tick at a time; errors are
 * logged and retried on the next tick.
 */
const config = require('../config');
const logger = require('../utils/logger');
const scheduling = require('./scheduling.service');

let timer = null;
let running = false;
let analyticsTimer = null;
let analyticsRunning = false;

/** Analytics ingestion pass (hourly <48h after publish, then daily; channels daily). */
async function analyticsTick() {
  if (analyticsRunning) return null;
  analyticsRunning = true;
  try {
    const summary = await require('./analytics.ingest').runIngestion(new Date());
    if (summary.posts || summary.channels) logger.info({ summary }, 'analytics ingestion');
    return summary;
  } catch (err) {
    logger.error({ err }, 'analytics ingestion failed');
    return null;
  } finally {
    analyticsRunning = false;
  }
}

async function tick() {
  if (running) return null;
  running = true;
  try {
    const summary = await scheduling.runDue(new Date());
    if (summary.published || summary.failed) logger.info({ summary }, 'scheduler tick');
    return summary;
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
    return null;
  } finally {
    running = false;
  }
}

function start(intervalMs = config.scheduler.intervalMs) {
  if (timer || !intervalMs) return;
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 2000).unref?.();
  logger.info({ intervalMs, mode: require('./scheduling').mode() }, 'publishing scheduler started');
  const aMs = config.analytics.intervalMs;
  if (aMs && !analyticsTimer) {
    analyticsTimer = setInterval(analyticsTick, aMs);
    if (analyticsTimer.unref) analyticsTimer.unref();
    setTimeout(analyticsTick, 5000).unref?.();
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (analyticsTimer) clearInterval(analyticsTimer);
  analyticsTimer = null;
}

module.exports = { start, stop, tick, analyticsTick };

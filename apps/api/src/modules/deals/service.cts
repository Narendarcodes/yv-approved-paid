/**
 * deals/service: the running deal service (engine + Mongo + PayPal gateway).
 *
 *   dealService()              the process-wide service, built from env on first use
 *   configureDeals({ ... })    swap gateway / clock / base URL (tests, demo seeding)
 *   handlePaypalEvent(svc, e)  apply one verified PayPal webhook event
 *   startMoneyAgent() / stop   the tick loop (DEALS_TICK_MS, default 60 s; off in tests)
 */
import type { PaymentGateway } from './lib/gateway.cts';
import type { DealService } from './lib/service.cts';

const { makeDealService, ServiceError } = require('./lib/service.cts');
const { handlePaypalEvent } = require('./lib/webhooks.cts');
const { gatewayFromEnv } = require('./paypal.cts');

export type { DealService };

let svc: DealService | null = null;
let gatewayRef: PaymentGateway | null = null;
let timer: NodeJS.Timeout | null = null;

function configureDeals(opts: { gateway?: PaymentGateway; now?: () => string; publicBaseUrl?: string } = {}): DealService {
  gatewayRef = opts.gateway || gatewayFromEnv(process.env);
  svc = makeDealService({ gateway: gatewayRef as PaymentGateway, now: opts.now, publicBaseUrl: opts.publicBaseUrl || process.env.PUBLIC_WEB_URL });
  return svc as DealService;
}

function dealService(): DealService {
  return svc || configureDeals();
}
function gateway(): PaymentGateway {
  dealService();
  return gatewayRef as PaymentGateway;
}

function startMoneyAgent(log: { info: Function; error: Function } = console) {
  const every = Number(process.env.DEALS_TICK_MS || 60_000);
  if (timer || process.env.NODE_ENV === 'test' || every <= 0) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await dealService().tickAll();
      const moves = r.reduce((a, x) => a + x.moves, 0);
      if (moves) log.info({ moves, deals: r.length }, 'money agent tick');
    } catch (err) {
      log.error({ err }, 'money agent tick failed');
    } finally {
      running = false;
    }
  }, every);
  timer.unref?.();
}
function stopMoneyAgent() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { dealService, configureDeals, gateway, handlePaypalEvent, startMoneyAgent, stopMoneyAgent, ServiceError };

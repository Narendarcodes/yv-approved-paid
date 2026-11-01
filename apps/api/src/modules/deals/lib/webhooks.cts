/**
 * PayPal webhooks -> deals. The route has already checked the signature (the
 * gateway's verifyWebhook: PayPal's verify-webhook-signature API, or an HMAC
 * for the mock). Here: dedup by event id, find the deal by the PayPal id in
 * the event, and either act or reconcile.
 *
 *   CHECKOUT.ORDER.APPROVED        buyer approved the hold -> Money Agent authorizes it
 *   PAYMENT.AUTHORIZATION.VOIDED   hold released; if we did not void it, mark it and tell both sides
 *   PAYMENT.CAPTURE.COMPLETED      confirmation line on the ledger
 *   PAYMENT.CAPTURE.DENIED|REVERSED|REFUNDED   recorded loudly; a reversal flags the milestone
 *   PAYMENT.PAYOUTSBATCH.*  /  PAYMENT.PAYOUTS-ITEM.*   payout status updated
 * Anything else is acknowledged and ignored. A webhook never moves money by
 * itself except to finish funding the buyer already approved, and that still
 * goes through the policy engine.
 */
import type { DealDoc, MilestoneRuntime } from './types.cts';
import type { DealService } from './service.cts';

const { nextEntry } = require('./ledger.cts');

export type PaypalEvent = { id: string; event_type: string; resource?: any; create_time?: string };

function resourceIds(ev: PaypalEvent): string[] {
  const r = ev.resource || {};
  const ids = [r.id, r.supplementary_data?.related_ids?.authorization_id, r.supplementary_data?.related_ids?.order_id, r.batch_header?.payout_batch_id, r.payout_batch_id];
  for (const l of r.links || []) {
    const m = /\/(?:authorizations|captures|orders)\/([A-Z0-9-]+)/i.exec(l.href || '');
    if (m && l.rel === 'up') ids.push(m[1]);
  }
  return ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function milestoneFor(deal: DealDoc, ids: string[]): MilestoneRuntime | undefined {
  return deal.milestones.find(
    (m) =>
      ids.includes(m.funding?.orderId || '\0') ||
      ids.includes(m.funding?.authorizationId || '\0') ||
      (m.funding?.reauthorizations || []).some((r) => ids.includes(r.authorizationId)) ||
      m.captures.some((c) => ids.includes(c.id)) ||
      m.payouts.some((p) => ids.includes(p.batchId)),
  );
}

async function handlePaypalEvent(svc: DealService, ev: PaypalEvent): Promise<{ outcome: string; dealId?: string }> {
  if (!ev || typeof ev.id !== 'string' || typeof ev.event_type !== 'string') return { outcome: 'malformed' };
  if (await svc.webhookSeen(ev.id)) return { outcome: 'duplicate' };
  const ids = resourceIds(ev);
  let found: DealDoc | null = null;
  for (const id of ids) {
    found = await svc.findByPaypalId(id);
    if (found) break;
  }
  if (!found) {
    await svc.webhookRecord({ id: ev.id, eventType: ev.event_type, resourceId: ids[0], outcome: 'no_deal' });
    return { outcome: 'no_deal' };
  }
  const dealId = found.id;
  let outcome = 'recorded';

  if (ev.event_type === 'CHECKOUT.ORDER.APPROVED') {
    const m = milestoneFor(found, ids);
    if (m && m.state === 'SIGNED' && m.funding?.status === 'CREATED') {
      const r = await svc.confirmFunding(dealId, undefined, undefined, m.key);
      outcome = `authorize:${r.out.outcome}`;
    } else outcome = 'already_funded';
  } else {
    await svc.withDeal(dealId, undefined, async (d) => {
      const m = milestoneFor(d, ids);
      if (!m) return { deal: d, out: null };
      let next = d;
      let line = '';
      let flag = false;
      const put = (mm: MilestoneRuntime) => (next = { ...next, milestones: next.milestones.map((x) => (x.key === mm.key ? mm : x)) });
      const r = ev.resource || {};
      switch (ev.event_type) {
        case 'PAYMENT.AUTHORIZATION.VOIDED':
          if (m.funding && m.funding.status !== 'VOIDED' && m.funding.status !== 'CAPTURED') {
            put({ ...m, funding: { ...m.funding, status: 'VOIDED' } });
            line = 'PayPal reports the hold was released outside yv. (voided or expired). No money can be charged against it now; the client has to fund again.';
            flag = true;
          } else line = 'PayPal confirmed the hold was released.';
          break;
        case 'PAYMENT.CAPTURE.COMPLETED':
          line = `PayPal confirmed capture ${r.id} completed.`;
          break;
        case 'PAYMENT.CAPTURE.PENDING':
          line = `PayPal has capture ${r.id} pending (${r.status_details?.reason || 'no reason given'}).`;
          break;
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.REVERSED':
          line = `PayPal reports capture ${r.id} was ${ev.event_type.endsWith('DENIED') ? 'denied' : 'reversed'}. Payouts for this milestone are on hold until a person looks at it.`;
          flag = true;
          break;
        case 'PAYMENT.CAPTURE.REFUNDED':
          line = `PayPal confirmed a refund on capture ${r.id}.`;
          break;
        default:
          if (ev.event_type.startsWith('PAYMENT.PAYOUTSBATCH.') || ev.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
            const status = ev.event_type.split('.').pop() as string;
            const batch = r.batch_header?.payout_batch_id || r.payout_batch_id;
            put({ ...m, payouts: m.payouts.map((p) => (p.batchId === batch ? { ...p, status } : p)) });
            line = `PayPal payout ${batch} is now ${status.toLowerCase()}.`;
            flag = ['DENIED', 'FAILED', 'RETURNED', 'BLOCKED', 'UNCLAIMED'].includes(status);
          } else return { deal: d, out: null };
      }
      if (flag) next = { ...next, alerts: [...(next.alerts || []), { at: svc.deps.now(), milestoneKey: m.key, eventType: ev.event_type, message: line }] };
      const prev = await svc.ledger.last(d.id);
      await svc.ledger.append(
        nextEntry(prev, { dealId: d.id, orgId: d.orgId, milestoneKey: m.key, currency: d.terms.currency, at: svc.deps.now(), type: 'webhook', amountMinor: 0, moved: false, actor: 'paypal', paypalRef: r.id, explanation: line }),
      );
      outcome = flag ? 'flagged' : 'recorded';
      return { deal: next, out: null };
    });
  }
  await svc.webhookRecord({ id: ev.id, eventType: ev.event_type, resourceId: ids[0], dealId, outcome });
  return { outcome, dealId };
}

module.exports = { handlePaypalEvent, resourceIds };

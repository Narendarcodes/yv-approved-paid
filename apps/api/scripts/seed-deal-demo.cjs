/**
 * Seeds the "Approved = Paid" judge demo: org, judge/editor/motion users and the
 * fixed deal "Diwali launch reels" (deal_demo_diwali) in every demo state
 * (docs/phase4-ui-plan.md section 6). Idempotent: re-running rebuilds that one deal.
 *
 *   MONGO_URI=... PAYPAL_MODE=mock node scripts/seed-deal-demo.cjs   -> prints {orgId, dealId, judge}
 *
 * Mock gateway only. The PayPal holds live in the mock's memory, so for clicking
 * through the demo prefer DEMO_MODE=1 on the API server, which runs this same
 * seed in-process on boot; this CLI is for inspecting the seeded states.
 * Evidence frames go to DEALS_EVIDENCE_DIR (default apps/api/uploads/deal-evidence).
 */
const mongoose = require('mongoose');
const { seedDealDemo } = require('../src/modules/deals/demo.cts');

if (require.main === module) {
  (async () => {
    if ((process.env.PAYPAL_MODE || 'mock') !== 'mock') {
      console.error('seed-deal-demo runs on the mock gateway only (PAYPAL_MODE=mock)');
      process.exit(2);
    }
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop');
    const out = await seedDealDemo({ judgePassword: process.env.DEMO_JUDGE_PASSWORD });
    console.log(JSON.stringify(out, null, 2));
    await mongoose.disconnect();
  })().catch(async (err) => {
    console.error('seed-deal-demo failed:', err && err.message ? err.message : err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { seedDealDemo };

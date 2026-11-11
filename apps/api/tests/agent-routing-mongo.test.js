const mongoose = require('mongoose');
const { mongoStore, makeHourBudget, monthKey } = require('../src/agent/routing');

beforeAll(async () => {
  await require('../src/db/mongo').connect();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (global.__MONGOD__) await global.__MONGOD__.stop();
});

test('render_hours: one doc per UTC month, $inc counters, a sticky switchedAt', async () => {
  let t = Date.parse('2026-11-11T10:00:00Z');
  const now = () => t;
  const store = mongoStore(() => mongoose.connection.db);
  const b = makeHourBudget({ store, now, startedAt: t - 61_000, project: false, switchHours: 0.1 });
  expect(await b.countApi()).toBe(2); // 61 s -> 2 min
  await b.countAgent(4);
  let s = await b.evaluate(); // 6 min = 0.1 h -> switch
  expect(s).toMatchObject({ month: '2026-11', overBudget: true, switchedNow: true });
  const first = s.switchedAt;
  t += 4 * 60_000;
  await b.countApi();
  s = await b.evaluate();
  expect(s).toMatchObject({ overBudget: true, switchedNow: false, switchedAt: first });
  const doc = await store.get(monthKey(t));
  expect(doc).toMatchObject({ _id: '2026-11', apiMin: 6, agentMin: 4 + 15 });
});

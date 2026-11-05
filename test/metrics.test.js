'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const m = require('../src/metrics');

const T = (min) => new Date(Date.parse('2026-11-05T08:00:00Z') + min * 60000).toISOString();

test('routing stats: median, p90 and the share inside 5 minutes', () => {
  const rows = [1, 2, 3, 4, 10].map((min) => ({ intakeAt: T(0), routedAt: T(min) }));
  assert.deepEqual(m.routingStats(rows, cfg), { count: 5, median: 3, p90: 10, withinTarget: 0.8 });
  assert.equal(m.routingStats([], cfg).count, 0);
});

test('watchdog lists only unrouted leads nobody owns after 5 minutes, longest wait first', () => {
  const now = Date.parse(T(30));
  const rows = [
    { id: 1, name: 'Owned', intakeAt: T(0), ownerId: '31001' },
    { id: 2, name: 'Routed to a queue, or in shadow mode', intakeAt: T(0), routedAt: T(1) },
    { id: 3, name: 'Fresh', intakeAt: T(27) },
    { id: 4, name: 'Late', intakeAt: T(20) },
    { id: 5, name: 'Very late', intakeAt: T(1) },
  ];
  assert.deepEqual(m.watchdog(rows, now, cfg), [
    { contactId: '5', name: 'Very late', minutesWaiting: 29 },
    { contactId: '4', name: 'Late', minutesWaiting: 10 },
  ]);
});

test('completeness per record lists what is missing', () => {
  const c = m.recordCompleteness({ email: 'a@b.fi', firstname: 'A', lastname: ' ', jobtitle: null }, ['email', 'firstname', 'lastname', 'jobtitle']);
  assert.deepEqual(c, { filled: 2, total: 4, rate: 0.5, missing: ['lastname', 'jobtitle'] });
});

test('weekly digest', () => {
  const d = m.weeklyDigest([
    { intakeAt: T(0), routedAt: T(1), rule: 'region_round_robin', completenessPct: '100', needsReview: false },
    { intakeAt: T(0), routedAt: T(2), rule: 'open_deal', completenessPct: '80', needsReview: true },
    { intakeAt: T(0), routedAt: null, rule: null, completenessPct: null, needsReview: false },
    { intakeAt: T(0), routedAt: null, rule: null, ownerId: '31002', completenessPct: null, needsReview: false },
  ], cfg);
  assert.equal(d.leads, 4);
  assert.equal(d.notRouted, 1, 'a lead that already had an owner is not a miss');
  assert.deepEqual(d.byRule, { region_round_robin: 1, open_deal: 1, not_routed: 1, owned_before_intake: 1 });
  assert.equal(d.avgCompletenessPct, 90);
  assert.equal(d.needsReview, 1);
  assert.equal(d.routing.withinTarget, 1);
});

test('each stuck lead is alerted once, and forgotten after a day', () => {
  const store = {};
  const t0 = Date.parse('2026-11-05T09:00:00Z');
  const late = [{ contactId: '1', name: 'A', minutesWaiting: 6 }];
  assert.equal(m.firstAlerts(late, store, t0).length, 1);
  assert.equal(m.firstAlerts(late, store, t0 + 5 * 60000).length, 0);
  assert.equal(m.firstAlerts(late, store, t0 + 25 * 3600000).length, 1);
});

test('Slack texts for the watchdog and the Monday numbers', () => {
  const w = m.watchdogText([{ contactId: '8099', name: 'Stuck Lead', minutesWaiting: 11 }], cfg);
  assert.equal(w, '1 lead not routed and without an owner after 5 minutes:\n- Stuck Lead: waiting 11 min <https://app.hubspot.com/contacts/0000000/record/0-1/8099|open>');
  const d = m.weeklyDigest([{ intakeAt: T(0), routedAt: T(2), rule: 'open_deal', completenessPct: '80', needsReview: false }], cfg);
  const text = m.digestText(d, cfg, true);
  assert.match(text, /^Lead routing, last 7 days: 1 lead \(the latest 200 only/);
  assert.match(text, /median 2 min, p90 2 min, 100% within 5 minutes/);
  assert.match(text, /By rule: open_deal 1\.$/);
});

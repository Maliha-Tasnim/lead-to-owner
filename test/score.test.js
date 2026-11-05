'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const { fitScore, engagementScore, scoreLead } = require('../src/score');

const NOW = Date.parse('2026-11-05T09:00:00Z');
const DAY = 86400000;

test('fit score adds industry, size, region and seniority, with a reason per point', () => {
  const fit = fitScore({ industry: 'telecommunications', employees: 800, region: 'NORDICS', jobTitle: 'CTO' }, cfg);
  assert.equal(fit.total, 57);
  assert.deepEqual(fit.parts.map((p) => p[0]), ['industry_icp', 'employees_200_999', 'region_served', 'title_seniority']);
});

test('free mail costs 10 points and the fit score never goes below 0', () => {
  assert.equal(fitScore({ freeMail: true }, cfg).total, 0);
  assert.equal(fitScore({ industry: 'utilities', region: 'DACH', freeMail: true }, cfg).total, 20);
});

test('older signals decay with time since the last activity; the new form counts in full', () => {
  const busy = { formType: 'demo_request', pricingPageViews: 3, webinarAttended: true, emailClicks30d: 5 };
  const at = (days) => engagementScore({ ...busy, lastActivityAt: new Date(NOW - days * DAY).toISOString() }, NOW);
  assert.equal(at(0).total, 36);
  assert.equal(at(20).total, 31, '20 + 16 x 0.7');
  assert.equal(at(40).total, 26, '20 + 16 x 0.4');
  assert.equal(at(200).total, 23, '20 + 16 x 0.2');
  assert.deepEqual(at(40).parts.at(-1), ['older_activity_decay', -10]);
  const quiet = engagementScore({ formType: 'demo_request', lastActivityAt: new Date(NOW - 120 * DAY).toISOString() }, NOW);
  assert.equal(quiet.total, 20, 'a demo request today is worth its full points');
});

test('tier boundaries: 70 is A, 69 is B, 40 is B, 39 is C', () => {
  const at = (profile, activity) => scoreLead(profile, { lastActivityAt: new Date(NOW).toISOString(), ...activity }, NOW, cfg);
  const a70 = at({ industry: 'energy', employees: 5000, region: 'DACH', jobTitle: 'VP Operations' }, { formType: 'contact', pricingPageViews: 1 });
  assert.equal(a70.total, 70);
  assert.equal(a70.tier, 'A');
  const b69 = at({ industry: 'energy', employees: 500, region: 'DACH', jobTitle: 'CTO' }, { formType: 'contact', pricingPageViews: 1 });
  assert.equal(b69.total, 69);
  assert.equal(b69.tier, 'B');
  const b40 = at({ industry: 'logistics', employees: 60, region: 'UKI' }, { formType: 'contact', pricingPageViews: 1 });
  assert.equal(b40.total, 40);
  assert.equal(b40.tier, 'B');
  const c39 = at({ industry: 'logistics', employees: 60, region: 'UKI' }, { formType: 'contact', emailClicks30d: 1 });
  assert.equal(c39.total, 39);
  assert.equal(c39.tier, 'C');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/dedupe');

test('eventKey: same person, form and minute is one event', () => {
  const a = d.eventKey({ email: 'A.Person@x.com', formId: 'f1', submittedAt: '2026-11-05T08:18:10Z' });
  const b = d.eventKey({ email: 'a.person+promo@x.com', formId: 'f1', submittedAt: '2026-11-05T08:18:50Z' });
  assert.equal(a, b);
  assert.notEqual(a, d.eventKey({ email: 'a.person@x.com', formId: 'f1', submittedAt: '2026-11-05T08:19:01Z' }));
  assert.notEqual(a, d.eventKey({ email: 'a.person@x.com', formId: 'f2', submittedAt: '2026-11-05T08:18:10Z' }));
});

test('seenRecently remembers keys for the window and then forgets them', () => {
  const store = {};
  const t0 = Date.parse('2026-11-05T08:00:00Z');
  assert.equal(d.seenRecently('k', store, t0, 10), false);
  assert.equal(d.seenRecently('k', store, t0 + 60000, 10), true);
  assert.equal(d.seenRecently('k', store, t0 + 11 * 60000, 10), false, 'pruned after 10 minutes, then stored again');
  assert.deepEqual(Object.keys(store), ['k']);
});

test('contactDecision rejects bad emails and merges only on the same normalized email', () => {
  assert.deepEqual(d.contactDecision({ email: 'nope' }, [], '1'), { action: 'reject', reason: 'invalid_email' });
  assert.equal(d.contactDecision({ email: 'x@mailinator.com' }, [], '1').reason, 'disposable_email');
  const existing = [{ id: '7001', email: 'ingrid.berg@fjordnett.no' }, { id: '8018', email: 'Ingrid.Berg+webinar@fjordnett.no' }];
  assert.deepEqual(d.contactDecision({ email: 'Ingrid.Berg+webinar@fjordnett.no' }, existing, '8018'),
    { action: 'merge', keepId: '7001', mergeId: '8018', reason: 'same_normalized_email' });
  assert.equal(d.contactDecision({ email: 'ingrid@fjordnett.no' }, existing, '9').action, 'keep', 'a similar email is not the same mailbox');
  assert.equal(d.contactDecision({ email: 'solo@x.com' }, [{ id: '5', email: 'solo@x.com' }], '5').action, 'keep', 'the lead itself is not a duplicate');
});

test('companyDecision: exact domain associates, name alone only goes to review', () => {
  const companies = [
    { id: '1', name: 'Kestrel Metering Oy', domain: 'kestrelmetering.com', otherDomains: [] },
    { id: '2', name: 'Brightline Utilities Ltd', domain: 'brightline-utilities.co.uk', otherDomains: ['brightline.example'] },
  ];
  assert.deepEqual(d.companyDecision({ email: 'a@kestrelmetering.com' }, companies), { action: 'associate', companyId: '1', domain: 'kestrelmetering.com', reason: 'domain_match' });
  assert.equal(d.companyDecision({ email: 'a@brightline.example' }, companies).companyId, '2', 'additional domains count');
  const review = d.companyDecision({ email: 'a@brightline-utilities.nl', company: 'Brightline Utilities B.V.' }, companies);
  assert.equal(review.action, 'review');
  assert.deepEqual(review.candidateIds, ['2']);
  assert.equal(d.companyDecision({ email: 'a@gmail.com', company: 'Unknown' }, companies).action, 'none');
  assert.equal(d.companyDecision({ email: 'a@newco.fi', company: 'NewCo' }, companies).action, 'create');
  assert.deepEqual(d.companyDecision({ email: 'a@gmail.com', website: 'www.kestrelmetering.com' }, companies).companyId, '1', 'free mail falls back to the website');
});

test('leadDomain ignores free-mail domains', () => {
  assert.equal(d.leadDomain({ email: 'a@sub.kestrelmetering.com' }), 'kestrelmetering.com');
  assert.equal(d.leadDomain({ email: 'a@gmail.com' }), null);
  assert.equal(d.leadDomain({ email: 'a@gmail.com', website: 'https://nordvolt.fi/' }), 'nordvolt.fi');
});

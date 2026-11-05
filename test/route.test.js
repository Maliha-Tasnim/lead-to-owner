'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const crm = require('../src/crm');
const { route, nextRep } = require('../src/route');
const data = require('../fixtures/crm.json');

const owners = crm.toOwners({ results: data.owners }, cfg);
const company = (over) => ({ id: '9', name: 'Acme Oy', domain: 'acme.fi', otherDomains: [], lifecycle: 'lead', ownerId: null, openDealOwnerId: null, hqCountry: 'FI', ...over });
const ctx = (over) => ({
  country: 'FI', domain: 'acme.fi', company: null, companyMatch: null, contactOwnerId: null, rejectReason: null,
  classification: { intent: 'demo_request' }, tier: 'B', owners, cfg, lastAssigned: {}, ...over,
});

test('rule 1: throwaway emails and non-sales intents go to queues, even from customers', () => {
  assert.equal(route(ctx({ rejectReason: 'disposable_email' })).queue, 'discard');
  const r = route(ctx({ classification: { intent: 'support_request' }, company: company({ lifecycle: 'customer', ownerId: '31002' }) }));
  assert.equal(r.rule, 'non_sales_intent');
  assert.equal(r.queue, 'support');
  assert.equal(r.ownerId, null);
  assert.equal(route(ctx({ classification: { intent: 'job_application' } })).queue, 'hr');
  assert.equal(route(ctx({ classification: { intent: 'spam' } })).queue, 'discard');
});

test('rule 2 and 3: customer owner first, then open-deal owner', () => {
  assert.equal(route(ctx({ company: company({ lifecycle: 'customer', ownerId: '31002', openDealOwnerId: '31003' }) })).ownerId, '31002');
  const deal = route(ctx({ company: company({ lifecycle: 'opportunity', ownerId: '31004', openDealOwnerId: '31003' }) }));
  assert.equal(deal.rule, 'open_deal');
  assert.equal(deal.ownerId, '31003');
  const leftCustomer = route(ctx({ company: company({ lifecycle: 'customer', ownerId: '31014', openDealOwnerId: '31003' }) }));
  assert.equal(leftCustomer.rule, 'open_deal', 'a customer whose owner left falls through to the next rule');
});

test('rule 4: a global account keeps its named owner, even when the CRM record is missing', () => {
  const r = route(ctx({ country: 'NL', domain: 'brightline-utilities.nl' }));
  assert.equal(r.rule, 'global_account');
  assert.equal(r.ownerId, '31015');
  const inactive = route(ctx({ country: 'NL', domain: 'brightline-utilities.nl', owners: { ...owners, 31015: undefined } }));
  assert.equal(inactive.rule, 'region_round_robin', 'an inactive global owner falls through');
});

test('rule 5 and 6: company owner, or the team lead plus a reassign task when the owner has left', () => {
  assert.equal(route(ctx({ company: company({ ownerId: '31001' }) })).rule, 'company_owner');
  const left = route(ctx({ country: 'DE', company: company({ ownerId: '31014', hqCountry: 'SE' }) }));
  assert.equal(left.rule, 'departed_owner');
  assert.equal(left.ownerId, '31010', 'the team lead of the company\'s region, not the lead\'s');
  assert.deepEqual(left.actions, ['reassign_company']);
  assert.equal(left.alert, true);
});

test('rule 7: partner manager, after the account rules', () => {
  assert.equal(route(ctx({ classification: { intent: 'partnership' } })).ownerId, '31009');
  assert.equal(route(ctx({ classification: { intent: 'partnership' }, company: company({ lifecycle: 'customer', ownerId: '31002' }) })).ownerId, '31002', 'a customer asking about partnering stays with its account owner');
});

test('guard: a known contact with an active owner keeps it, unless the lead is not for sales', () => {
  const known = route(ctx({ contactOwnerId: '31002', company: company({ lifecycle: 'customer', ownerId: '31004' }) }));
  assert.equal(known.rule, 'already_owned');
  assert.equal(known.ownerId, '31002');
  assert.equal(route(ctx({ contactOwnerId: '31002', classification: { intent: 'support_request' } })).queue, 'support');
  assert.equal(route(ctx({ contactOwnerId: '31014' })).rule, 'region_round_robin', 'a departed contact owner does not count');
});

test('rule 8: round robin by region; tier A to senior reps; reps on leave skipped', () => {
  assert.equal(route(ctx({ tier: 'A', lastAssigned: { 31001: 5, 31002: 1 } })).ownerId, '31001');
  assert.equal(route(ctx({ tier: 'B', lastAssigned: { 31001: 5, 31002: 1 } })).ownerId, '31002');
  assert.equal(route(ctx({ tier: 'B', lastAssigned: { 31001: 1, 31002: 5 } })).ownerId, '31001');
  for (let i = 0; i < 3; i += 1) assert.equal(route(ctx({ country: 'GB', lastAssigned: { 31005: Date.now() } })).ownerId, '31005', '31006 is on leave');
  const seniorAway = crm.toOwners({ results: data.owners }, { ...cfg, unavailableOwners: ['31001'] });
  assert.equal(route(ctx({ tier: 'A', owners: seniorAway })).ownerId, '31002', 'no senior available: the whole pool');
});

test('rule 9: no region or nobody available goes to the routing queue with an alert', () => {
  const us = route(ctx({ country: 'US' }));
  assert.equal(us.rule, 'fallback_queue');
  assert.equal(us.queue, 'routing');
  assert.equal(us.alert, true);
  assert.match(us.reason, /outside the four regions/);
  const away = crm.toOwners({ results: data.owners }, { ...cfg, unavailableOwners: ['31005', '31006'] });
  assert.match(route(ctx({ country: 'IE', owners: away })).reason, /No available rep in UKI/);
});

test('the company head office stands in for a missing lead country', () => {
  const r = route(ctx({ country: null, company: company({ hqCountry: 'AT', ownerId: null }) }));
  assert.equal(r.region, 'DACH');
});

test('a company matched by name only still routes, with a request to check the match', () => {
  const r = route(ctx({ company: company({ ownerId: '31001' }), companyMatch: 'name' }));
  assert.equal(r.ownerId, '31001');
  assert.match(r.reason, /matched by name only/);
});

test('nextRep: never-assigned reps go first and ties keep the config order', () => {
  assert.equal(nextRep('DACH', 'B', cfg, owners, {}), '31003');
  assert.equal(nextRep('DACH', 'B', cfg, owners, { 31003: 10 }), '31004');
  assert.equal(nextRep('DACH', 'B', cfg, owners, { 31003: 10, 31004: 10 }), '31003');
  assert.equal(nextRep('MARS', 'B', cfg, owners, {}), null);
});

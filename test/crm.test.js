'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const crm = require('../src/crm');
const data = require('../fixtures/crm.json');

const NOW = Date.parse('2026-11-05T09:00:00Z');

test('contact search looks up the email key, the email and the lead\'s own record, oldest first', () => {
  const body = crm.contactSearchBody({ emailNorm: 'ingrid.berg@fjordnett.no', contactId: '8018' });
  assert.deepEqual(body.filterGroups.map((g) => g.filters[0].propertyName), ['lr_email_key', 'email', 'hs_object_id']);
  assert.ok(body.properties.includes('lr_routed_at'));
  assert.deepEqual(body.sorts, [{ propertyName: 'createdate', direction: 'ASCENDING' }]);
  assert.deepEqual(crm.contactSearchBody({ emailNorm: null }).filterGroups, [{ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: '0' }] }], 'nothing to look for: a search that matches nothing');
});

test('company search casts a wide net: domain, additional domains and the longest name word', () => {
  const body = crm.companySearchBody({ email: 'r.devries@brightline-utilities.nl', company: 'Brightline Utilities B.V.' });
  assert.deepEqual(body.filterGroups.map((g) => [g.filters[0].propertyName, g.filters[0].operator, g.filters[0].value]), [
    ['domain', 'EQ', 'brightline-utilities.nl'],
    ['hs_additional_domains', 'CONTAINS_TOKEN', 'brightline-utilities.nl'],
    ['name', 'CONTAINS_TOKEN', 'brightline'],
  ]);
  const gmail = crm.companySearchBody({ email: 'jari@gmail.com', company: 'Nordvolt Data Centers' });
  assert.deepEqual(gmail.filterGroups.map((g) => g.filters[0].propertyName), ['name']);
  assert.ok(gmail.filterGroups.length <= 5, 'HubSpot allows at most 5 filter groups');
});

test('deal, round-robin, watchdog and digest searches', () => {
  const deals = crm.dealSearchBody('9003');
  assert.deepEqual(deals.filterGroups[0].filters.map((f) => f.propertyName), ['associations.company', 'hs_is_closed']);
  const recent = crm.recentAssignmentsBody(NOW, cfg);
  assert.equal(recent.filterGroups[0].filters[1].value, String(NOW - 30 * crm.DAY_MS));
  const wd = crm.watchdogBody(NOW, cfg);
  assert.equal(wd.filterGroups[0].filters[1].value, String(NOW - 5 * 60000));
  assert.deepEqual(wd.filterGroups[0].filters.slice(2).map((f) => [f.propertyName, f.operator]), [['lr_routed_at', 'NOT_HAS_PROPERTY'], ['hubspot_owner_id', 'NOT_HAS_PROPERTY']]);
  assert.equal(crm.digestBody(NOW).filterGroups[0].filters[0].value, String(NOW - 7 * crm.DAY_MS));
});

test('companies are mapped to small shapes with normalized fields', () => {
  const [alpen] = crm.toCompanies({ results: data.companies.filter((c) => c.id === '9003') });
  assert.deepEqual(alpen, { id: '9003', name: 'Alpenwerk Energie GmbH', domain: 'alpenwerk-energie.de', otherDomains: [], lifecycle: 'opportunity', ownerId: '31004', hqCountry: 'DE', industry: 'energy', employees: 2300 });
  const [x] = crm.toCompanies({ results: [{ id: 1, properties: { hs_additional_domains: 'a.example;www.b.example', hubspot_owner_id: '', numberofemployees: '0' } }] });
  assert.deepEqual(x.otherDomains, ['a.example', 'b.example']);
  assert.equal(x.ownerId, null);
  assert.equal(x.employees, null);
});

test('open-deal owner is the owner of the latest open deal', () => {
  assert.equal(crm.openDealOwner({ results: data.deals }), '31003', 'the newer deal is closed, so it does not count');
  assert.equal(crm.openDealOwner(null), null);
});

test('owners: archived users are gone, reps on leave are unavailable', () => {
  const owners = crm.toOwners({ results: data.owners }, cfg);
  assert.equal(owners['31014'], undefined);
  assert.equal(owners['31006'].available, false);
  assert.equal(owners['31001'].slackId, 'U01NORD1');
  assert.equal(owners['31001'].name, 'Aino Virta');
});

test('lastAssignedFrom keeps the latest time per rep, from ISO or epoch values', () => {
  const last = crm.lastAssignedFrom({ results: [
    { properties: { lr_routed_owner_id: '1', lr_routed_at: '2026-11-04T08:00:00Z' } },
    { properties: { lr_routed_owner_id: '1', lr_routed_at: String(Date.parse('2026-11-05T08:00:00Z')) } },
    { properties: { lr_routed_owner_id: '2', lr_routed_at: 'not a date' } },
  ] });
  assert.deepEqual(last, { 1: Date.parse('2026-11-05T08:00:00Z') });
});

const result = (over) => ({
  lead: { jobTitle: '' },
  profile: { country: 'FI', industry: 'utilities', employees: 120, jobTitle: 'Engineer' },
  score: { tier: 'B', total: 54, fit: { total: 44, parts: [['industry_icp', 20], ['free_mail', -10]] }, engagement: { total: 10, parts: [['form_contact', 10]] } },
  classification: { intent: 'demo_request', product_interest: 'iot_platform', urgency: 'high', source: 'ai', summary: 'x', needsReview: false },
  routing: { rule: 'region_round_robin', ownerId: '31002', queue: null, reason: 'Next rep', region: 'NORDICS' },
  companyDecision: { action: 'create' },
  enrichmentStatus: 'enriched',
  completeness: { rate: 8 / 9 },
  routedAt: '2026-11-05T08:22:00.000Z',
  emailKey: 'liisa.koski@saimaagrid.fi',
  duplicateOf: null,
  ...over,
});

test('write-back: live assigns the owner, shadow only records it', () => {
  const live = crm.writeBackProperties(result(), cfg);
  assert.equal(live.hubspot_owner_id, '31002');
  assert.equal(live.lr_routed_owner_id, '31002');
  assert.equal(live.lr_completeness_pct, '89');
  assert.equal(live.lr_score_reasons, 'industry_icp +20, free_mail -10, form_contact +10');
  assert.equal(live.jobtitle, 'Engineer', 'filled from Clay because the form had no job title');
  assert.equal(live.lr_ai_product_interest, 'iot_platform');
  assert.equal(live.lr_ai_urgency, 'high');
  const shadow = crm.writeBackProperties(result({ duplicateOf: '7001' }), { ...cfg, mode: 'shadow' });
  assert.equal(shadow.hubspot_owner_id, undefined);
  assert.equal(shadow.lr_routed_owner_id, '31002');
  assert.equal(shadow.lr_duplicate_of, '7001');
});

test('write-back never clears an owner and never overwrites a job title from the form', () => {
  const queued = crm.writeBackProperties(result({ routing: { rule: 'non_sales_intent', ownerId: null, queue: 'support', reason: 'x', region: null }, lead: { jobTitle: 'CTO' } }), cfg);
  assert.equal('hubspot_owner_id' in queued, false);
  assert.equal(queued.lr_routing_queue, 'support');
  assert.equal('jobtitle' in queued, false);
  assert.equal(crm.writeBackProperties(result({ companyDecision: { action: 'review' } }), cfg).lr_needs_review, 'true');
});

test('reassign task: high priority, due tomorrow, linked to the company', () => {
  const body = crm.reassignTaskBody({ id: '9002', name: 'Harbor Fiber AB' }, { ownerId: '31010' }, NOW);
  assert.equal(body.properties.hubspot_owner_id, '31010');
  assert.equal(body.properties.hs_timestamp, new Date(NOW + crm.DAY_MS).toISOString());
  assert.deepEqual(body.associations[0], { to: { id: '9002' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 192 }] });
});

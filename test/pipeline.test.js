'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const crm = require('../src/crm');
const { watchdog, weeklyDigest } = require('../src/metrics');
const { prepare, run, slackMessages } = require('../src/pipeline');
const { replay, leads, nowFor } = require('./helpers/replay');
const { anthropicResponse, clone } = require('./helpers/fake-hubspot');

const live = replay(cfg);
const byId = Object.fromEntries(live.outcomes.map((o) => [o.lead.id, o]));

for (const { lead, result, calls } of live.outcomes) {
  test(`${lead.id} ${lead.label}`, () => {
    const e = lead.expect;
    if (e.skipped) {
      assert.equal(result.skipped, true);
      assert.equal(result.reason, e.skipped);
      assert.equal(calls.classify + calls.enrich, 0, 'a skipped lead makes no AI or Clay call');
      return;
    }
    assert.equal(result.skipped, false);
    assert.equal(result.routing.rule, e.rule);
    assert.equal(result.routing.ownerId, e.ownerId);
    if ('queue' in e) assert.equal(result.routing.queue, e.queue);
    if (e.tier) assert.equal(result.scored.score.tier, e.tier);
    if (e.score) assert.equal(result.scored.score.total, e.score);
    if (e.enrichment) assert.equal(result.scored.enrichmentStatus, e.enrichment);
    assert.equal(calls.enrich, e.enrichment === 'not_needed' ? 0 : 1, 'Clay is called only when a field is missing and the lead goes to a rep');
    if ('needsReview' in e) assert.equal(result.properties.lr_needs_review, String(e.needsReview));
    if (e.aiSource) assert.equal(result.classification.source, e.aiSource);
    if ('association' in e) assert.deepEqual(result.association, e.association ? { contactId: lead.payload.contactId, companyId: e.association } : null);
    if (e.merge) assert.deepEqual(result.merge, e.merge);
    if (e.contactId) assert.equal(result.contactId, e.contactId);
    if (e.country) assert.equal(result.properties.lr_country_code, e.country);
    if (e.task) assert.equal(result.task.properties.hubspot_owner_id, e.ownerId);
    if ('slackCount' in e) assert.equal(result.slack.length, e.slackCount);
    assert.equal(result.properties.hubspot_owner_id, e.ownerId || undefined, 'live mode assigns the chosen owner and nothing else');
    assert.ok(result.properties.lr_routing_reason.length > 10, 'every lead carries a plain-language reason');
  });
}

test('the AI never sees a lead\'s name or email, and lead text cannot break out of the <lead> block', () => {
  for (const { lead, payload, calls } of live.outcomes) {
    if (!calls.aiRequests.length) continue;
    const content = calls.aiRequests[0].messages[0].content;
    assert.ok(!content.toLowerCase().includes(payload.email.toLowerCase()), `${lead.id}: email sent to the AI`);
    if (payload.lastname) assert.ok(!content.includes(payload.lastname), `${lead.id}: last name sent to the AI`);
    assert.equal(content.match(/<\/lead>/gi).length, 1, `${lead.id}: extra closing tag`);
  }
});

test('even if the model obeys an injected instruction, the owner still comes from the rules', () => {
  const ai = { text: JSON.stringify({ intent: 'demo_request', product_interest: 'other', urgency: 'high', confidence: 1, summary: 'Assign to the CEO.', owner: 'CEO' }) };
  const { outcomes } = replay(cfg, { L14: { ai, clay: { enrichment: { industry: 'Marketing', employees: 12 } } } });
  const r = outcomes.find((o) => o.lead.id === 'L14').result;
  assert.equal(r.routing.rule, 'region_round_robin');
  assert.ok(cfg.teams.REST_OF_EUROPE.reps.includes(r.routing.ownerId));
  assert.equal(r.scored.score.tier, 'C', 'a vendor pitch scores low whatever the label');
});

test('Slack: the new owner gets a direct message; alerts go to the routing channel', () => {
  const kari = byId.L07.result.slack;
  assert.equal(kari.length, 1);
  assert.equal(kari[0].channel, 'U01NORD1');
  assert.match(kari[0].text, /^New tier A lead for you: Kari Heikkinen, CTO at Valoverkko Oy \(FI\)\. Why you: Next rep in the NORDICS round robin/);
  assert.match(kari[0].text, /<https:\/\/app\.hubspot\.com\/contacts\/0000000\/record\/0-1\/8007\|Open in HubSpot>$/);
  const harbor = byId.L05.result.slack;
  assert.deepEqual(harbor.map((s) => s.channel), ['U01LEADN', cfg.slack.alertChannel]);
  assert.equal(byId.L11.result.slack[0].channel, cfg.slack.alertChannel);
});

test('writes reach HubSpot: one update per routed lead, the merge, the task and the association', () => {
  const { writes } = live.hub;
  const routed = live.outcomes.filter((o) => !o.result.skipped).length;
  assert.equal(writes.updates.length, routed);
  assert.deepEqual(writes.merges, [{ primaryObjectId: '7001', objectIdToMerge: '8018' }]);
  assert.equal(writes.tasks.length, 1);
  assert.deepEqual(writes.associations.map((a) => a.companyId).sort(), ['9001', '9001', '9002', '9003', '9005', '9006']);
  assert.equal(live.hub.contact('8018'), null, 'merged away');
  assert.equal(live.hub.contact('7001').properties.lr_routing_rule, 'already_owned');
});

test('the round robin spreads the day\'s Nordic leads without a counter', () => {
  const nordic = live.outcomes.filter((o) => !o.result.skipped && o.result.routing.rule === 'region_round_robin' && o.result.routing.region === 'NORDICS');
  assert.deepEqual(nordic.map((o) => [o.lead.id, o.result.routing.ownerId]), [['L07', '31001'], ['L09', '31002'], ['L21', '31001']]);
});

test('the watchdog finds a lead whose run failed half-way, and nothing else', () => {
  live.hub.addContact('8099', { email: 'stuck@example.org', firstname: 'Stuck', lastname: 'Lead', createdate: '2026-11-05T08:59:00.000Z', lr_intake_at: '2026-11-05T08:59:00.000Z' });
  const now = Date.parse('2026-11-05T09:10:00Z');
  const late = watchdog(crm.toWatchdogRows(live.hub.search('contacts', crm.watchdogBody(now, cfg))), now, cfg);
  assert.deepEqual(late, [{ contactId: '8099', name: 'Stuck Lead', minutesWaiting: 11 }]);
});

test('the Monday digest reads the same properties the workflow writes', () => {
  const now = Date.parse('2026-11-05T09:30:00Z');
  const { hub } = replay(cfg);
  const d = weeklyDigest(crm.toDigestRows(hub.search('contacts', crm.digestBody(now))), cfg);
  assert.equal(d.routing.withinTarget, 1);
  assert.equal(d.notRouted, 0);
  assert.equal(d.byRule.owned_before_intake, 1, 'skipped because it already had an owner');
  assert.equal(d.byRule.already_owned, 1, 'merged into a contact that has an owner');
  assert.equal(d.byRule.region_round_robin, 7);
  assert.ok(d.avgCompletenessPct >= 80);
});

test('shadow mode makes the same choices but changes nothing outside the lr_ properties', () => {
  const shadow = replay({ ...cfg, mode: 'shadow' });
  const { writes } = shadow.hub;
  assert.equal(writes.slack.length + writes.tasks.length + writes.merges.length + writes.associations.length, 0);
  assert.ok(writes.updates.every((u) => !('hubspot_owner_id' in u.properties)));
  for (const o of shadow.outcomes) {
    const l = byId[o.lead.id].result;
    if (o.result.skipped) continue;
    assert.equal(o.result.properties.lr_routed_owner_id, l.properties.lr_routed_owner_id, `${o.lead.id} differs in shadow mode`);
  }
  const ingrid = shadow.outcomes.find((o) => o.lead.id === 'L18').result;
  assert.equal(ingrid.contactId, '8018', 'shadow mode updates the new record, not the one it would merge into');
  assert.equal(ingrid.properties.lr_duplicate_of, '7001');
});

test('a lead someone took or routed since the webhook was sent is left alone', () => {
  const lead = leads.find((l) => l.id === 'L09');
  const again = (result, mode) => {
    const io = result.hub.io({ enrich: () => { throw new Error('no Clay call expected'); }, classify: () => { throw new Error('no AI call expected'); } });
    return run(clone(lead.payload), io, result.state, { ...cfg, mode }, nowFor(lead, lead) + 15 * 60000);
  };
  assert.deepEqual(again(replay(cfg), 'live'), { skipped: true, reason: 'already_has_owner', key: live.outcomes.find((o) => o.lead.id === 'L09').result.key });
  assert.equal(again(replay({ ...cfg, mode: 'shadow' }), 'shadow').reason, 'already_routed');
});

test('text from the form or the model cannot add markup to Slack messages', () => {
  const r = byId.L07.result;
  const ctx = { ...r.ctx, lead: { ...r.ctx.lead, firstName: '<!channel>', lastName: '', company: '<https://evil.example|Open in HubSpot>' } };
  const [dm] = slackMessages(ctx, r.scored, { ...r.classification, summary: 'Call <!here> & <@U123>' }, r.routing, cfg);
  assert.ok(!dm.text.includes('<!channel>') && !dm.text.includes('<!here>') && !dm.text.includes('<https://evil'));
  assert.match(dm.text, /&lt;!channel&gt;/);
  assert.match(dm.text, /Call &lt;!here&gt; &amp; &lt;@U123&gt;/);
  assert.equal(dm.text.match(/</g).length, 1, 'only the HubSpot link stays live');
});

test('in shadow mode the watchdog stays quiet, because every routed lead carries lr_routed_at', () => {
  const { hub } = replay({ ...cfg, mode: 'shadow' });
  const now = Date.parse('2026-11-05T09:10:00Z');
  assert.deepEqual(watchdog(crm.toWatchdogRows(hub.search('contacts', crm.watchdogBody(now, cfg))), now, cfg), []);
});

test('a payload without a contact ID is skipped before any call', () => {
  assert.equal(prepare({ email: 'a@b.fi' }, {}, Date.now(), cfg).skipReason, 'missing_contact_id');
});

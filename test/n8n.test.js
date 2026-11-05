'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const crm = require('../src/crm');
const { weeklyDigest, digestText } = require('../src/metrics');
const { build, serialize, OUT } = require('../n8n/build-workflow');
const { MiniN8n } = require('./helpers/mini-n8n');
const { FakeHubSpot, anthropicResponse, clone } = require('./helpers/fake-hubspot');
const { replay, leads, crmData, addLeadContact, nowFor } = require('./helpers/replay');

const wf = build();
const names = wf.nodes.map((n) => n.name);
const TRIGGERS = ['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger'];

test('the workflow file is up to date with src/ (run npm run build after changing src/)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), serialize(wf));
});

test('structure: unique names and IDs, valid connections, nothing unreachable', () => {
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(wf.nodes.map((n) => n.id)).size, names.length);
  const incoming = new Set();
  for (const [from, conn] of Object.entries(wf.connections)) {
    assert.ok(names.includes(from), `unknown source ${from}`);
    for (const branch of conn.main) for (const t of branch) {
      assert.ok(names.includes(t.node), `unknown target ${t.node}`);
      incoming.add(t.node);
    }
  }
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.stickyNote') continue;
    if (TRIGGERS.includes(n.type)) assert.ok(!incoming.has(n.name), `${n.name} is a trigger with an input`);
    else assert.ok(incoming.has(n.name), `${n.name} is never reached`);
  }
  assert.equal(wf.connections['Company found?'].main.length, 2);
  assert.equal(wf.connections['Needs enrichment?'].main.length, 2);
  assert.equal(wf.connections['Send to Clay'].main.length, 2, 'success goes to the Wait, a failed call straight to scoring');
});

test('every $(\'Node\') reference points to a node that exists, and every Code node compiles', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const text = JSON.stringify(wf.nodes.map((n) => n.parameters));
  for (const m of text.matchAll(/\$\('([^']+)'\)/g)) assert.ok(names.includes(m[1]), `$('${m[1]}') has no node`);
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$', '$input', '$json', '$execution', '$getWorkflowStaticData', n.parameters.jsCode), n.name);
    assert.ok(n.parameters.jsCode.length < 60000, `${n.name} is unexpectedly large`);
  }
});

test('credentials and safety settings on the nodes that need them', () => {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
    if (n.parameters.url.includes('api.hubapi.com')) assert.ok(n.credentials && n.credentials.hubspotAppToken, `${n.name} needs the HubSpot credential`);
    assert.equal(n.retryOnFail, true, `${n.name} should retry`);
  }
  assert.equal(byName['Lead intake'].parameters.authentication, 'headerAuth');
  assert.equal(byName['Wait for Clay'].parameters.incomingAuthentication, 'headerAuth');
  assert.equal(byName['Wait for Clay'].parameters.resumeAmount, cfg.enrichment.waitMinutes);
  assert.equal(byName['Classify with Claude'].onError, 'continueRegularOutput');
  assert.equal(wf.settings.executionOrder, 'v1');
  assert.equal(wf.active, false, 'imported switched off');
});

test('no dashes that read as AI-written text, in the workflow or the source', () => {
  const files = [OUT, ...fs.readdirSync(path.join(__dirname, '..', 'src')).map((f) => path.join(__dirname, '..', 'src', f))];
  for (const f of files) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} has an en or em dash`);
});

// Runs every fixture lead through the built workflow, then compares with pipeline.run() on the same data.
async function runWorkflow() {
  const hub = new FakeHubSpot(crmData);
  const staticData = {};
  const byId = Object.fromEntries(leads.map((l) => [l.id, l]));
  const runs = [];
  for (const lead of leads) {
    const source = lead.repeatOf ? byId[lead.repeatOf] : lead;
    const payload = clone(source.payload);
    addLeadContact(hub, payload);
    const calls = { ai: [], clay: [] };
    const engine = new MiniN8n(wf, {
      staticData,
      waitAnswer: () => source.clay,
      http: async ({ method, url, body, headers, node }) => {
        let m;
        if (method === 'POST' && (m = /^https:\/\/api\.hubapi\.com\/crm\/objects\/2026-09\/(contacts|companies|deals)\/search$/.exec(url))) return hub.search(m[1], body);
        if (method === 'GET' && url.startsWith('https://api.hubapi.com/crm/owners/2026-09?')) return hub.getOwners();
        if (method === 'PATCH' && (m = /^https:\/\/api\.hubapi\.com\/crm\/objects\/2026-09\/contacts\/(\d+)$/.exec(url))) {
          hub.updateContact(m[1], body.properties);
          return { id: m[1], properties: body.properties };
        }
        if (method === 'PUT' && (m = /^https:\/\/api\.hubapi\.com\/crm\/objects\/2026-09\/contact\/(\d+)\/associations\/default\/company\/(\d+)$/.exec(url))) {
          hub.associateCompany(m[1], m[2]);
          return { status: 'COMPLETE' };
        }
        if (method === 'POST' && url === 'https://api.hubapi.com/crm/objects/2026-09/tasks') {
          hub.createTask(body);
          return { id: '1' };
        }
        if (method === 'POST' && url === 'https://api.hubapi.com/crm/objects/2026-09/contacts/merge') {
          hub.mergeContacts(body);
          return { id: body.primaryObjectId };
        }
        if (method === 'POST' && url === 'https://slack.com/api/chat.postMessage') {
          hub.postSlack({ channel: body.channel, text: body.text });
          return { ok: true };
        }
        if (method === 'POST' && url === 'https://api.anthropic.com/v1/messages') {
          assert.equal(headers['anthropic-version'], '2026-10-21');
          assert.equal('temperature' in body, false);
          calls.ai.push(body);
          const res = anthropicResponse(source.ai);
          if (res.type === 'error') throw new Error(`Request failed with status code 529: ${res.error.type}`);
          return res;
        }
        if (method === 'POST' && url.startsWith('https://api.clay.com/')) {
          if (source.clay === undefined) throw new Error(`${lead.id}: Clay should not be called`);
          assert.equal(body.callback_url, 'https://n8n.example.com/webhook-waiting/test?signature=abc');
          calls.clay.push(body);
          return { success: true };
        }
        throw new Error(`No fake for ${method} ${url} (${node})`);
      },
    });
    const webhookItem = { json: { headers: {}, params: {}, query: {}, body: payload } };
    await engine.run('Lead intake', [webhookItem], nowFor(lead, source));
    runs.push({ lead, engine, calls });
  }
  return { hub, runs, staticData };
}

test('the built workflow routes every made-up lead exactly like the tested code', async () => {
  const expected = replay(cfg);
  const { hub, runs } = await runWorkflow();
  for (let i = 0; i < runs.length; i += 1) {
    const { lead, engine, calls } = runs[i];
    const want = expected.outcomes[i].result;
    if (want.skipped) {
      assert.deepEqual(engine.order, ['Lead intake', 'Prepare lead'], `${lead.id} should stop at Prepare lead`);
      continue;
    }
    const got = engine.outputs['Route lead'][0][0].json;
    assert.deepEqual(got.routing, want.routing, `${lead.id} routing`);
    assert.deepEqual(got.properties, want.properties, `${lead.id} properties`);
    assert.deepEqual(got.slack, want.slack, `${lead.id} Slack`);
    assert.deepEqual([got.task, got.merge, got.association], [want.task, want.merge, want.association], `${lead.id} task, merge, association`);
    assert.equal(calls.clay.length, want.scored.enrichmentStatus === 'not_needed' ? 0 : 1, `${lead.id} Clay calls`);
    assert.equal(engine.order.includes('Find open deals'), Boolean(want.ctx.company), `${lead.id} deal search only with a company`);
  }
  assert.deepEqual(hub.writes, expected.hub.writes, 'the same writes reach HubSpot and Slack');
});

test('a Slack error reply (HTTP 200 with ok: false) fails the run instead of passing silently', async () => {
  const lead = leads.find((l) => l.id === 'L05');
  const hub = new FakeHubSpot(crmData);
  addLeadContact(hub, lead.payload);
  const engine = new MiniN8n(wf, {
    waitAnswer: () => null,
    http: async (req) => {
      const search = /\/crm\/objects\/2026-09\/(contacts|companies|deals)\/search$/.exec(req.url);
      if (search) return hub.search(search[1], req.body);
      if (req.url.includes('/crm/owners/')) return hub.getOwners();
      if (req.url === 'https://api.anthropic.com/v1/messages') return anthropicResponse(lead.ai);
      if (req.url === 'https://slack.com/api/chat.postMessage') return { ok: false, error: 'channel_not_found' };
      return { ok: true };
    },
  });
  await assert.rejects(engine.run('Lead intake', [{ json: { body: clone(lead.payload) } }], nowFor(lead, lead)), /Slack did not accept 2 message\(s\): channel_not_found, channel_not_found/);
  assert.ok(engine.order.includes('Update contact'), 'HubSpot was updated before the Slack step');
});

test('a failed Clay call skips the wait and still routes the lead', async () => {
  const lead = leads.find((l) => l.id === 'L07');
  const hub = new FakeHubSpot(crmData);
  addLeadContact(hub, lead.payload);
  const engine = new MiniN8n(wf, {
    waitAnswer: () => { throw new Error('the Wait node should not run'); },
    http: async (req) => {
      if (req.url.startsWith('https://api.clay.com/')) throw new Error('Request failed with status code 500');
      if (req.url === 'https://api.anthropic.com/v1/messages') return anthropicResponse(lead.ai);
      const search = /\/crm\/objects\/2026-09\/(contacts|companies|deals)\/search$/.exec(req.url);
      if (search) return hub.search(search[1], req.body);
      if (req.url.includes('/crm/owners/')) return hub.getOwners();
      return { ok: true };
    },
  });
  await engine.run('Lead intake', [{ json: { body: clone(lead.payload) } }], nowFor(lead, lead));
  assert.ok(!engine.order.includes('Wait for Clay'));
  const out = engine.outputs['Route lead'][0][0].json;
  assert.equal(out.properties.lr_enrichment_status, 'no_answer');
  assert.equal(out.routing.rule, 'region_round_robin');
});

test('watchdog and Monday numbers run on the same HubSpot data', async () => {
  const { hub, staticData } = await runWorkflow();
  hub.addContact('8099', { email: 'stuck@example.org', firstname: 'Stuck', lastname: 'Lead', createdate: '2026-11-05T08:59:00.000Z', lr_intake_at: '2026-11-05T08:59:00.000Z' });
  const http = async (req) => {
    if (req.url.endsWith('/contacts/search')) return hub.search('contacts', req.body);
    if (req.url === 'https://slack.com/api/chat.postMessage') {
      hub.postSlack(req.body);
      return { ok: true };
    }
    throw new Error(`unexpected ${req.url}`);
  };
  const engine = new MiniN8n(wf, { http, staticData, waitAnswer: () => null });
  const before = hub.writes.slack.length;
  await engine.run('Every 5 minutes', [{ json: {} }], Date.parse('2026-11-05T09:10:00Z'));
  assert.equal(hub.writes.slack.length, before + 1);
  assert.match(hub.writes.slack.at(-1).text, /^1 lead not routed and without an owner after 5 minutes:\n- Stuck Lead: waiting 11 min/);
  await engine.run('Every 5 minutes', [{ json: {} }], Date.parse('2026-11-05T09:15:00Z'));
  assert.equal(hub.writes.slack.length, before + 1, 'reported once, not every 5 minutes');

  const now = Date.parse('2026-11-05T09:30:00Z');
  await engine.run('Mondays 07:30', [{ json: {} }], now);
  const page = hub.search('contacts', crm.digestBody(now));
  assert.equal(hub.writes.slack.at(-1).text, digestText(weeklyDigest(crm.toDigestRows(page), cfg), cfg, false));
  assert.match(hub.writes.slack.at(-1).text, /^Lead routing, last 7 days: 22 leads\.\nTime to owner or queue: median 1 min/);
});

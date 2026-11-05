'use strict';
// Runs every made-up lead in fixtures/leads.json through pipeline.run() against one fake HubSpot, in time order,
// the way the n8n workflow would process them one after another. Each lead runs 60 seconds after it was submitted.

const { run } = require('../../src/pipeline');
const { FakeHubSpot, anthropicResponse, clone } = require('./fake-hubspot');
const crmData = require('../../fixtures/crm.json');
const { leads } = require('../../fixtures/leads.json');

// HubSpot creates the contact before its workflow calls the webhook, so the fake does the same.
function addLeadContact(hub, payload) {
  hub.addContact(payload.contactId, {
    email: payload.email,
    firstname: payload.firstname,
    lastname: payload.lastname,
    company: payload.company,
    createdate: payload.submitted_at,
    lr_intake_at: payload.lr_intake_at,
    hubspot_owner_id: payload.hubspot_owner_id || '',
  });
}

function nowFor(lead, source) {
  return new Date(source.payload.submitted_at).getTime() + 1000 * (lead.delaySeconds || 60);
}

// overrides: { [leadId]: { ai, clay } } to swap a fixture answer in a test.
function replay(cfg, overrides = {}) {
  const hub = new FakeHubSpot(crmData);
  const state = { idem: {} };
  const byId = Object.fromEntries(leads.map((l) => [l.id, l]));
  const outcomes = [];
  for (const lead of leads) {
    const source = { ...(lead.repeatOf ? byId[lead.repeatOf] : lead), ...(overrides[lead.id] || {}) };
    const payload = clone(source.payload);
    addLeadContact(hub, payload);
    const calls = { enrich: 0, classify: 0, clayRequests: [], aiRequests: [] };
    const io = hub.io({
      enrich: (req) => {
        calls.enrich += 1;
        calls.clayRequests.push(req);
        if (source.clay === undefined) throw new Error(`${lead.id}: Clay was called, but this lead should not need enrichment`);
        return source.clay;
      },
      classify: (req) => {
        calls.classify += 1;
        calls.aiRequests.push(req);
        return anthropicResponse(source.ai);
      },
    });
    const nowMs = nowFor(lead, source);
    outcomes.push({ lead, payload, nowMs, calls, result: run(payload, io, state, cfg, nowMs) });
  }
  return { hub, outcomes, state };
}

module.exports = { replay, leads, crmData, addLeadContact, nowFor };

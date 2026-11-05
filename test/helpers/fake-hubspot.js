'use strict';
// A small in-memory HubSpot for tests. It answers the search bodies the workflow builds (filter groups ORed,
// filters ANDed; EQ, NEQ, GT, LT, CONTAINS_TOKEN, HAS_PROPERTY, NOT_HAS_PROPERTY; one sort; a limit), so the
// request bodies are tested together with the logic, and it records every write the workflow makes.

const { toMs } = require('../../src/crm');

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function tokens(v) {
  const s = String(v).toLowerCase();
  return new Set([...s.split(/[;,\s]+/), ...s.split(/[^a-z0-9]+/)].filter(Boolean));
}

function valueOf(record, prop) {
  if (prop === 'hs_object_id') return record.id;
  return record.properties[prop];
}

function matches(record, f) {
  if (f.propertyName === 'associations.company') {
    const linked = ((record.associations && record.associations.company) || []).map(String).includes(String(f.value));
    if (f.operator === 'EQ') return linked;
    throw new Error(`Fake HubSpot: unsupported operator ${f.operator} on associations.company`);
  }
  const v = valueOf(record, f.propertyName);
  const has = !(v === undefined || v === null || v === '');
  switch (f.operator) {
    case 'HAS_PROPERTY': return has;
    case 'NOT_HAS_PROPERTY': return !has;
    case 'EQ': return has && String(v).toLowerCase() === String(f.value).toLowerCase();
    case 'NEQ': return !has || String(v).toLowerCase() !== String(f.value).toLowerCase();
    case 'GT': return has && toMs(v) > Number(f.value);
    case 'LT': return has && toMs(v) < Number(f.value);
    case 'CONTAINS_TOKEN': return has && tokens(v).has(String(f.value).toLowerCase());
    default: throw new Error(`Fake HubSpot: unsupported operator ${f.operator}`);
  }
}

function compare(a, b) {
  const x = toMs(a);
  const y = toMs(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a === undefined || a === null ? '' : a).localeCompare(String(b === undefined || b === null ? '' : b));
}

class FakeHubSpot {
  constructor(data) {
    const d = clone(data);
    this.db = { contacts: d.contacts || [], companies: d.companies || [], deals: d.deals || [] };
    this.owners = d.owners || [];
    this.writes = { updates: [], merges: [], tasks: [], associations: [], slack: [] };
    this.calls = [];
  }

  addContact(id, properties) {
    if (!this.db.contacts.some((c) => c.id === String(id))) this.db.contacts.push({ id: String(id), properties: { ...properties } });
  }

  contact(id) {
    return this.db.contacts.find((c) => c.id === String(id)) || null;
  }

  search(type, body) {
    this.calls.push({ op: 'search', type, body: clone(body) });
    if (!body || !Array.isArray(body.filterGroups) || !body.filterGroups.length) throw new Error('Fake HubSpot: filterGroups required');
    if (body.filterGroups.length > 5) throw new Error('Fake HubSpot: HubSpot allows at most 5 filter groups');
    const rows = this.db[type].filter((r) => body.filterGroups.some((g) => g.filters.every((f) => matches(r, f))));
    const sort = (body.sorts || [])[0];
    if (sort) rows.sort((a, b) => compare(valueOf(a, sort.propertyName), valueOf(b, sort.propertyName)) * (sort.direction === 'DESCENDING' ? -1 : 1));
    const limit = body.limit || 10;
    return {
      total: rows.length,
      results: rows.slice(0, limit).map((r) => {
        const properties = { hs_object_id: r.id };
        for (const p of body.properties || []) properties[p] = r.properties[p] === undefined ? null : r.properties[p];
        return { id: r.id, properties, createdAt: r.properties.createdate || null, updatedAt: r.updatedAt || null, archived: false };
      }),
    };
  }

  getOwners() {
    this.calls.push({ op: 'owners' });
    return { results: clone(this.owners.filter((o) => !o.archived)) };
  }

  updateContact(id, properties) {
    const c = this.contact(id);
    if (!c) throw new Error(`Fake HubSpot: contact ${id} not found`);
    this.writes.updates.push({ id: String(id), properties: clone(properties) });
    Object.assign(c.properties, properties);
  }

  mergeContacts({ primaryObjectId, objectIdToMerge }) {
    const keep = this.contact(primaryObjectId);
    const gone = this.contact(objectIdToMerge);
    if (!keep || !gone) throw new Error('Fake HubSpot: merge needs two existing contacts');
    for (const [k, v] of Object.entries(gone.properties)) {
      if (keep.properties[k] === undefined || keep.properties[k] === null || keep.properties[k] === '') keep.properties[k] = v;
    }
    this.db.contacts = this.db.contacts.filter((c) => c.id !== String(objectIdToMerge));
    this.writes.merges.push({ primaryObjectId: String(primaryObjectId), objectIdToMerge: String(objectIdToMerge) });
  }

  createTask(body) {
    this.writes.tasks.push(clone(body));
  }

  associateCompany(contactId, companyId) {
    this.writes.associations.push({ contactId: String(contactId), companyId: String(companyId) });
  }

  postSlack(msg) {
    this.writes.slack.push(clone(msg));
  }

  // The io object pipeline.run() expects; enrich and classify are added per lead by the caller.
  io(extra) {
    return {
      searchContacts: (b) => this.search('contacts', b),
      searchCompanies: (b) => this.search('companies', b),
      searchDeals: (b) => this.search('deals', b),
      getOwners: () => this.getOwners(),
      updateContact: (id, p) => this.updateContact(id, p),
      mergeContacts: (b) => this.mergeContacts(b),
      createTask: (b) => this.createTask(b),
      associateCompany: (c, co) => this.associateCompany(c, co),
      postSlack: (m) => this.postSlack(m),
      ...extra,
    };
  }
}

// Wraps a fixture's AI answer in the Anthropic Messages API response shape.
function anthropicResponse(ai) {
  if (!ai) return { type: 'error', error: { type: 'api_error', message: 'no answer in fixture' } };
  if (ai.error) return { type: 'error', error: ai.error };
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: ai.text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 180, output_tokens: 60 },
  };
}

module.exports = { FakeHubSpot, anthropicResponse, clone };

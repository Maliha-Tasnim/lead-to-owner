'use strict';
// Everything that knows HubSpot's API: the search bodies the workflow sends, the mapping of responses to the small
// shapes the rules use, and the properties and records written back. The rules never see a HubSpot field name.
// Custom properties start with lr_ so they are easy to find, report on and remove.

const { rootDomain, normCountry, normIndustry, normCompanyName } = require('./normalize');
const { leadDomain } = require('./dedupe');

const DAY_MS = 86400000;
const NO_MATCH = { filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: '0' }] };
const COMPANY_PROPS = ['name', 'domain', 'hs_additional_domains', 'lifecyclestage', 'hubspot_owner_id', 'country', 'industry', 'numberofemployees'];

function results(resp) {
  return resp && Array.isArray(resp.results) ? resp.results : [];
}

// HubSpot returns datetimes as ISO strings, and accepts epoch milliseconds in search filters.
function toMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return /^\d+$/.test(String(v)) ? Number(v) : new Date(v).getTime();
}

// ---------- search bodies (POST /crm/objects/2026-09/{type}/search; filter groups are ORed, filters ANDed) ----------

// Candidates for the duplicate check. HubSpot already refuses a second contact with the same email, so the
// duplicates that get through are variants (+tags, Gmail dots, googlemail.com). The workflow stores a normalized
// email key on every contact it handles (lr_email_key) and searches on it; filter groups are ORed.
function contactSearchBody(lead) {
  const groups = [];
  if (lead.emailNorm) {
    groups.push({ filters: [{ propertyName: 'lr_email_key', operator: 'EQ', value: lead.emailNorm }] });
    groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.emailNorm }] });
  }
  // The lead's own record too: the webhook payload is a snapshot, and someone may have taken the lead since.
  if (lead.contactId) groups.push({ filters: [{ propertyName: 'hs_object_id', operator: 'EQ', value: String(lead.contactId) }] });
  return {
    filterGroups: groups.length ? groups : [NO_MATCH],
    properties: ['email', 'lr_email_key', 'hubspot_owner_id', 'lr_routed_at', 'createdate'],
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
    limit: 10,
  };
}

// A wide net (primary domain, additional domains, the longest word of the name); the code then decides exactly.
function companySearchBody(lead) {
  const groups = [];
  const domain = leadDomain(lead);
  if (domain) {
    groups.push({ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] });
    groups.push({ filters: [{ propertyName: 'hs_additional_domains', operator: 'CONTAINS_TOKEN', value: domain }] });
  }
  const words = normCompanyName(lead.company || '').split(' ').filter((w) => w.length >= 4).sort((a, b) => b.length - a.length);
  if (words.length) groups.push({ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: words[0] }] });
  return { filterGroups: groups.length ? groups : [NO_MATCH], properties: COMPANY_PROPS, limit: 20 };
}

function dealSearchBody(companyId) {
  return {
    filterGroups: [{ filters: [
      { propertyName: 'associations.company', operator: 'EQ', value: String(companyId) },
      { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
    ] }],
    properties: ['dealname', 'hubspot_owner_id', 'hs_is_closed', 'hs_lastmodifieddate'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit: 10,
  };
}

// The latest round-robin assignments, so the round robin needs no counter of its own.
function recentAssignmentsBody(nowMs, cfg) {
  return {
    filterGroups: [{ filters: [
      { propertyName: 'lr_routing_rule', operator: 'EQ', value: 'region_round_robin' },
      { propertyName: 'lr_routed_at', operator: 'GT', value: String(nowMs - cfg.roundRobinLookbackDays * DAY_MS) },
    ] }],
    properties: ['lr_routed_owner_id', 'lr_routed_at'],
    sorts: [{ propertyName: 'lr_routed_at', direction: 'DESCENDING' }],
    limit: 100,
  };
}

// Leads that entered the workflow in the last 24 hours, more than 5 minutes ago, that the workflow never finished
// and nobody owns. lr_intake_at is set by the HubSpot workflow that sends the webhook, so a run that failed half-way
// is caught, and leads parked in a queue or routed in shadow mode are not (they carry lr_routed_at).
function watchdogBody(nowMs, cfg) {
  return {
    filterGroups: [{ filters: [
      { propertyName: 'lr_intake_at', operator: 'GT', value: String(nowMs - DAY_MS) },
      { propertyName: 'lr_intake_at', operator: 'LT', value: String(nowMs - cfg.sla.ownerMinutes * 60000) },
      { propertyName: 'lr_routed_at', operator: 'NOT_HAS_PROPERTY' },
      { propertyName: 'hubspot_owner_id', operator: 'NOT_HAS_PROPERTY' },
    ] }],
    properties: ['firstname', 'lastname', 'company', 'lr_intake_at', 'lr_routed_at', 'hubspot_owner_id'],
    sorts: [{ propertyName: 'lr_intake_at', direction: 'ASCENDING' }],
    limit: 100,
  };
}

// Last week's leads for the Monday numbers. One page (HubSpot's maximum of 200) is enough at this volume;
// the HubSpot reports hold the rest, and the Slack post says so when there are more.
function digestBody(nowMs) {
  return {
    filterGroups: [{ filters: [{ propertyName: 'lr_intake_at', operator: 'GT', value: String(nowMs - 7 * DAY_MS) }] }],
    properties: ['lr_intake_at', 'lr_routed_at', 'lr_routing_rule', 'lr_completeness_pct', 'lr_needs_review', 'hubspot_owner_id'],
    sorts: [{ propertyName: 'lr_intake_at', direction: 'DESCENDING' }],
    limit: 200,
  };
}

// ---------- responses -> small shapes ----------

function toContacts(resp) {
  return results(resp).map((r) => {
    const p = r.properties || {};
    return {
      id: String(r.id),
      email: p.email || '',
      ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
      routedAt: p.lr_routed_at || null,
      createdAt: p.createdate || r.createdAt || null,
    };
  });
}

function toCompanies(resp) {
  return results(resp).map((r) => {
    const p = r.properties || {};
    return {
      id: String(r.id),
      name: p.name || '',
      domain: rootDomain(p.domain || ''),
      otherDomains: String(p.hs_additional_domains || '').split(/[;,\s]+/).map((d) => rootDomain(d)).filter(Boolean),
      lifecycle: p.lifecyclestage || null,
      ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
      hqCountry: normCountry(p.country || ''),
      industry: normIndustry(p.industry),
      employees: Number(p.numberofemployees) > 0 ? Number(p.numberofemployees) : null,
    };
  });
}

// Owner of the most recently updated open deal, or null.
function openDealOwner(resp) {
  const open = results(resp)
    .filter((d) => d.properties && String(d.properties.hs_is_closed) !== 'true' && d.properties.hubspot_owner_id)
    .sort((a, b) => (toMs(b.updatedAt || b.properties.hs_lastmodifieddate) || 0) - (toMs(a.updatedAt || a.properties.hs_lastmodifieddate) || 0));
  return open.length ? String(open[0].properties.hubspot_owner_id) : null;
}

// GET /crm/owners/2026-09?archived=false -> { [ownerId]: { name, active, available, slackId } }.
// An owner ID missing from this list belongs to someone who has left (rule 6).
function toOwners(resp, cfg) {
  const owners = {};
  for (const o of results(resp)) {
    if (o.archived) continue;
    const id = String(o.id);
    owners[id] = {
      name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || id,
      active: true,
      available: !(cfg.unavailableOwners || []).includes(id),
      slackId: (cfg.ownerSlackIds || {})[id] || null,
    };
  }
  return owners;
}

// { [ownerId]: ms of that rep's latest round-robin lead }
function lastAssignedFrom(resp) {
  const last = {};
  for (const r of results(resp)) {
    const p = r.properties || {};
    const id = p.lr_routed_owner_id ? String(p.lr_routed_owner_id) : null;
    const t = toMs(p.lr_routed_at);
    if (id && Number.isFinite(t) && t > (last[id] || 0)) last[id] = t;
  }
  return last;
}

function toWatchdogRows(resp) {
  return results(resp).map((r) => {
    const p = r.properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') + (p.company ? ` (${p.company})` : '');
    return { id: String(r.id), name: name.trim(), intakeAt: p.lr_intake_at || null, ownerId: p.hubspot_owner_id || null, routedAt: p.lr_routed_at || null };
  });
}

function toDigestRows(resp) {
  return results(resp).map((r) => {
    const p = r.properties || {};
    return { intakeAt: p.lr_intake_at || null, routedAt: p.lr_routed_at || null, rule: p.lr_routing_rule || null, ownerId: p.hubspot_owner_id || null, completenessPct: p.lr_completeness_pct, needsReview: String(p.lr_needs_review) === 'true' };
  });
}

// ---------- write-back ----------

// PATCH /crm/objects/2026-09/contacts/{id}. In shadow mode the owner is recorded but not assigned.
// The workflow never clears an owner: it only sets one when a rule picked one.
function writeBackProperties(r, cfg) {
  const props = {
    lr_routed_owner_id: r.routing.ownerId || '',
    lr_routed_at: r.routedAt,
    lr_routing_queue: r.routing.queue || '',
    lr_routing_rule: r.routing.rule,
    lr_routing_reason: r.routing.reason,
    lr_region: r.routing.region || '',
    lr_lead_tier: r.score.tier,
    lr_lead_score: String(r.score.total),
    lr_fit_score: String(r.score.fit.total),
    lr_engagement_score: String(r.score.engagement.total),
    lr_score_reasons: [...r.score.fit.parts, ...r.score.engagement.parts].map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', '),
    lr_ai_intent: r.classification.intent,
    lr_ai_product_interest: r.classification.product_interest || '',
    lr_ai_urgency: r.classification.urgency || '',
    lr_ai_source: r.classification.source,
    lr_ai_summary: r.classification.summary || '',
    lr_needs_review: String(Boolean(r.classification.needsReview || r.companyDecision.action === 'review')),
    lr_enrichment_status: r.enrichmentStatus,
    lr_completeness_pct: String(Math.round(r.completeness.rate * 100)),
    lr_country_code: r.profile.country || '',
    lr_industry: r.profile.industry || '',
    lr_employees: r.profile.employees ? String(r.profile.employees) : '',
  };
  if (r.emailKey) props.lr_email_key = r.emailKey;
  if (!r.lead.jobTitle && r.profile.jobTitle) props.jobtitle = r.profile.jobTitle;
  if (cfg.mode === 'live' && r.routing.ownerId) props.hubspot_owner_id = r.routing.ownerId;
  if (cfg.mode !== 'live' && r.duplicateOf) props.lr_duplicate_of = r.duplicateOf;
  return props;
}

// POST /crm/objects/2026-09/tasks, linked to the company (HubSpot-defined association type 192: task to company).
function reassignTaskBody(company, routing, nowMs) {
  return {
    properties: {
      hs_timestamp: new Date(nowMs + DAY_MS).toISOString(),
      hs_task_subject: `Reassign ${company.name || 'this company'}: its owner has left`,
      hs_task_body: 'A new lead came in for this company and was routed to you because its owner is no longer an active HubSpot user. Pick a new owner for the company and its open contacts.',
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'HIGH',
      hs_task_type: 'TODO',
      hubspot_owner_id: routing.ownerId,
    },
    associations: [{ to: { id: String(company.id) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 192 }] }],
  };
}

module.exports = {
  DAY_MS, toMs,
  contactSearchBody, companySearchBody, dealSearchBody, recentAssignmentsBody, watchdogBody, digestBody,
  toContacts, toCompanies, openDealOwner, toOwners, lastAssignedFrom, toWatchdogRows, toDigestRows,
  writeBackProperties, reassignTaskBody,
};

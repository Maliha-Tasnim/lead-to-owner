'use strict';
// The workflow as six steps. Each n8n Code node calls one of them, and run() chains them with the same API calls
// for local runs and tests, so the code that is tested is the code that runs in n8n.
//
//  prepare()       read the webhook payload; skip repeats, leads without an ID and leads that already have an owner
//  match()         skip a lead someone took meanwhile; duplicate-contact and company decisions from the two searches
//  buildContext()  open-deal owner, active owners, the AI request
//  readAi()        check the AI answer; decide whether Clay enrichment is worth its credits
//  score()         merge the enrichment (if it came back in time) and score the lead
//  finish()        apply the nine rules, build the CRM update, Slack messages, task, merge and association
//
// The AI runs before Clay on purpose: support requests, job seekers and spam never spend enrichment credits.

const { normEmail, normCountry, isFreeMail } = require('./normalize');
const { eventKey, seenRecently, contactDecision, companyDecision } = require('./dedupe');
const { scoreLead } = require('./score');
const { buildRequest, parseResponse, decide } = require('./classify');
const { route, regionOf, NON_SALES } = require('./route');
const { clayRequest, parseClay } = require('./enrich');
const { recordCompleteness } = require('./metrics');
const crm = require('./crm');

// payload: the JSON body the HubSpot workflow's webhook action sends (see README, "Webhook payload").
function prepare(payload, idemStore, nowMs, cfg) {
  const p = payload || {};
  const lead = {
    contactId: p.contactId ? String(p.contactId) : null,
    email: String(p.email || ''),
    firstName: String(p.firstname || ''),
    lastName: String(p.lastname || ''),
    jobTitle: String(p.jobtitle || ''),
    company: String(p.company || ''),
    website: String(p.website || ''),
    country: normCountry(String(p.country || '')),
    message: String(p.message || ''),
    formId: String(p.form_id || ''),
    formName: String(p.form_name || ''),
    formType: String(p.form_type || ''),
    submittedAt: p.submitted_at || new Date(nowMs).toISOString(),
    intakeAt: p.lr_intake_at || p.submitted_at || new Date(nowMs).toISOString(),
    activity: {
      formType: String(p.form_type || ''),
      pricingPageViews: Number(p.pricing_page_views) || 0,
      webinarAttended: p.webinar_attended === true || p.webinar_attended === 'true',
      emailClicks30d: Number(p.email_clicks_30d) || 0,
      lastActivityAt: p.last_activity_at || p.submitted_at || null,
    },
  };
  const e = normEmail(lead.email);
  lead.emailNorm = e ? e.email : null;
  lead.freeMail = e ? isFreeMail(e.domain) : false;
  const key = eventKey(lead);
  if (!lead.contactId) return { skip: true, skipReason: 'missing_contact_id', key, lead };
  if (p.hubspot_owner_id) return { skip: true, skipReason: 'already_has_owner', key, lead };
  if (seenRecently(key, idemStore, nowMs, cfg.idempotencyWindowMin)) return { skip: true, skipReason: 'repeat_event', key, lead };
  return { skip: false, skipReason: null, key, lead, search: { contacts: crm.contactSearchBody(lead), companies: crm.companySearchBody(lead) } };
}

function match(lead, contactsResp, companiesResp) {
  const contacts = crm.toContacts(contactsResp);
  const companies = crm.toCompanies(companiesResp);
  const contact = contactDecision(lead, contacts, lead.contactId);
  const companyDec = companyDecision(lead, companies);
  // A single name-only candidate may decide the owner (flagged for review), but is never associated automatically.
  let companyId = null;
  let companyMatch = null;
  if (companyDec.action === 'associate') {
    companyId = companyDec.companyId;
    companyMatch = 'domain';
  } else if (companyDec.action === 'review' && companyDec.candidateIds.length === 1) {
    companyId = companyDec.candidateIds[0];
    companyMatch = 'name';
  }
  const company = companyId ? companies.find((c) => c.id === companyId) || null : null;
  const kept = contact.action === 'merge' ? contacts.find((c) => c.id === contact.keepId) : null;
  // The payload is a snapshot from enrollment; the record itself says whether the lead was taken or routed since.
  const self = lead.contactId ? contacts.find((c) => c.id === String(lead.contactId)) : null;
  const skip = self && self.ownerId ? 'already_has_owner' : self && self.routedAt ? 'already_routed' : null;
  return {
    skip,
    lead,
    contact,
    companyDecision: companyDec,
    company,
    companyMatch: company ? companyMatch : null,
    contactOwnerId: kept ? kept.ownerId : null,
    dealSearch: company ? crm.dealSearchBody(company.id) : null,
  };
}

function buildContext(m, dealsResp, ownersResp, cfg) {
  const isMerge = m.contact.action === 'merge';
  return {
    lead: m.lead,
    contact: m.contact,
    companyDecision: m.companyDecision,
    company: m.company ? { ...m.company, openDealOwnerId: crm.openDealOwner(dealsResp) } : null,
    companyMatch: m.companyMatch,
    owners: crm.toOwners(ownersResp, cfg),
    contactOwnerId: m.contactOwnerId,
    rejectReason: m.contact.action === 'reject' ? m.contact.reason : null,
    // After a live merge the older record survives, so every update goes to it.
    targetContactId: cfg.mode === 'live' && isMerge ? m.contact.keepId : m.lead.contactId,
    aiRequest: buildRequest(m.lead, cfg),
  };
}

// aiResponse: the Anthropic Messages API response, or an error object if the call failed after its retries.
function readAi(ctx, aiResponse, cfg) {
  const classification = decide(parseResponse(aiResponse), ctx.lead, cfg);
  const company = ctx.company || {};
  const missing = [];
  if (!ctx.lead.jobTitle) missing.push('job_title');
  if (!ctx.lead.country && !company.hqCountry) missing.push('country');
  if (!company.industry) missing.push('industry');
  if (!company.employees) missing.push('employees');
  const goingToRep = !ctx.rejectReason && !NON_SALES[classification.intent];
  const needsEnrichment = goingToRep && missing.length > 0;
  return { classification, missing, needsEnrichment, clayRequest: needsEnrichment ? clayRequest(ctx.lead, ctx.companyDecision.domain, missing) : null };
}

// enrichmentBody: what Clay posted back to the Wait node, or null when Clay did not answer in time or the call failed.
function score(ctx, ai, enrichmentBody, nowMs, cfg) {
  const en = ai.needsEnrichment ? parseClay(enrichmentBody) : null;
  const company = ctx.company || {};
  const profile = {
    // The person's own country first, then Clay's, then the company's head office.
    country: ctx.lead.country || (en && en.country) || company.hqCountry || null,
    // CRM values first: people curate them. Clay fills the gaps.
    industry: company.industry || (en && en.industry) || null,
    employees: company.employees || (en && en.employees) || null,
    jobTitle: ctx.lead.jobTitle || (en && en.jobTitle) || '',
    freeMail: ctx.lead.freeMail,
  };
  profile.region = regionOf(profile.country, cfg);
  return {
    profile,
    score: scoreLead(profile, ctx.lead.activity, nowMs, cfg),
    enrichmentStatus: !ai.needsEnrichment ? 'not_needed' : en ? 'enriched' : 'no_answer',
    recentSearch: crm.recentAssignmentsBody(nowMs, cfg),
  };
}

// Slack reads <, > and & as markup (links, @channel), so every piece of text that came from a form or a model is
// escaped. Only the HubSpot link, which the workflow builds itself, stays live.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slackMessages(ctx, scored, classification, routing, cfg) {
  const lead = ctx.lead;
  const who = esc([lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.emailNorm || 'Unknown');
  const where = esc([scored.profile.jobTitle, lead.company].filter(Boolean).join(' at '));
  const line = `${who}${where ? `, ${where}` : ''} (${esc(scored.profile.country || 'country unknown')})`;
  const link = ctx.targetContactId ? ` <${cfg.hubspotPortalUrl}/record/0-1/${ctx.targetContactId}|Open in HubSpot>` : '';
  const reason = esc(routing.reason);
  const out = [];
  if (routing.ownerId) {
    const owner = ctx.owners[routing.ownerId] || {};
    const summary = classification.summary ? ` Summary: ${esc(classification.summary)}` : '';
    out.push(owner.slackId
      ? { channel: owner.slackId, text: `New tier ${scored.score.tier} lead for you: ${line}. Why you: ${reason}.${summary}${link}` }
      : { channel: cfg.slack.alertChannel, text: `New tier ${scored.score.tier} lead for ${esc(owner.name || routing.ownerId)} (no Slack ID on file): ${line}. Why: ${reason}.${link}` });
  }
  if (routing.alert) out.push({ channel: cfg.slack.alertChannel, text: `Routing alert: ${reason}. Lead: ${line}.${link}` });
  return out;
}

// recentResp: the search for recent round-robin assignments.
function finish(ctx, ai, scored, recentResp, nowMs, cfg) {
  const live = cfg.mode === 'live';
  const { classification } = ai;
  const routing = route({
    country: scored.profile.country,
    domain: ctx.companyDecision.domain,
    company: ctx.company,
    companyMatch: ctx.companyMatch,
    contactOwnerId: ctx.contactOwnerId,
    rejectReason: ctx.rejectReason,
    classification,
    tier: scored.score.tier,
    owners: ctx.owners,
    cfg,
    lastAssigned: crm.lastAssignedFrom(recentResp),
  });
  const completeness = recordCompleteness({
    email: ctx.lead.emailNorm,
    firstname: ctx.lead.firstName,
    lastname: ctx.lead.lastName,
    jobtitle: scored.profile.jobTitle,
    company: ctx.lead.company || (ctx.company && ctx.company.name),
    country: scored.profile.country,
    industry: scored.profile.industry,
    employees: scored.profile.employees,
    owner: routing.ownerId || routing.queue,
  }, cfg.keyFields);
  const isMerge = ctx.contact.action === 'merge';
  const properties = crm.writeBackProperties({
    lead: ctx.lead,
    profile: scored.profile,
    score: scored.score,
    classification,
    routing,
    companyDecision: ctx.companyDecision,
    enrichmentStatus: scored.enrichmentStatus,
    completeness,
    routedAt: new Date(nowMs).toISOString(),
    emailKey: ctx.lead.emailNorm,
    duplicateOf: isMerge ? ctx.contact.keepId : null,
  }, cfg);
  return {
    contactId: ctx.targetContactId,
    properties,
    routing,
    classification,
    completeness,
    slack: live ? slackMessages(ctx, scored, classification, routing, cfg) : [],
    task: live && routing.actions.includes('reassign_company') && ctx.company ? crm.reassignTaskBody(ctx.company, routing, nowMs) : null,
    merge: live && isMerge && ctx.contact.mergeId ? { primaryObjectId: ctx.contact.keepId, objectIdToMerge: ctx.contact.mergeId } : null,
    association: live && ctx.companyMatch === 'domain' ? { contactId: ctx.targetContactId, companyId: ctx.company.id } : null,
  };
}

// Local runner: the same steps and API calls as the n8n workflow, with the calls passed in as functions (io).
// io: searchContacts, searchCompanies, searchDeals, getOwners, classify, enrich, updateContact,
//     associateCompany, postSlack, createTask, mergeContacts. Used by the tests and scripts/replay.js.
function run(payload, io, state, cfg, nowMs) {
  state.idem = state.idem || {};
  const prep = prepare(payload, state.idem, nowMs, cfg);
  if (prep.skip) return { skipped: true, reason: prep.skipReason, key: prep.key };
  const contactsResp = io.searchContacts(prep.search.contacts);
  const companiesResp = io.searchCompanies(prep.search.companies);
  const ownersResp = io.getOwners();
  const m = match(prep.lead, contactsResp, companiesResp);
  if (m.skip) return { skipped: true, reason: m.skip, key: prep.key };
  const dealsResp = m.dealSearch ? io.searchDeals(m.dealSearch) : null;
  const ctx = buildContext(m, dealsResp, ownersResp, cfg);
  const ai = readAi(ctx, io.classify(ctx.aiRequest), cfg);
  const enrichmentBody = ai.needsEnrichment ? io.enrich(ai.clayRequest) : null;
  const scored = score(ctx, ai, enrichmentBody, nowMs, cfg);
  const out = finish(ctx, ai, scored, io.searchContacts(scored.recentSearch), nowMs, cfg);
  io.updateContact(out.contactId, out.properties);
  out.slack.forEach((msg) => io.postSlack(msg));
  if (out.association) io.associateCompany(out.association.contactId, out.association.companyId);
  if (out.task) io.createTask(out.task);
  if (out.merge) io.mergeContacts(out.merge);
  return { skipped: false, key: prep.key, ctx, ai, scored, ...out };
}

module.exports = { prepare, match, buildContext, readAi, score, finish, slackMessages, esc, run };

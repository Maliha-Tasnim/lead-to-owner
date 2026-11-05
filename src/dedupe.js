'use strict';
// Duplicate handling at two levels:
//  1. the same webhook event arriving twice (HubSpot retries, double form submits): skip it;
//  2. the same person or company already in the CRM: merge on an exact key, never on a guess.
// A wrong merge is hard to undo, so only an exact email key merges and a name-only company match goes to review.

const { normEmail, rootDomain, normCompanyName, isFreeMail, isDisposable, fnv1a } = require('./normalize');

// Same email + same form + same minute = same event.
function eventKey(event) {
  const e = normEmail(event.email);
  const t = new Date(event.submittedAt || 0).getTime();
  const minute = Number.isFinite(t) ? Math.floor(t / 60000) : 0;
  return fnv1a([e ? e.email : String(event.email || ''), event.formId || '', minute].join('|'));
}

// store is a plain object kept between runs (n8n: workflow static data). Old keys are pruned on every call.
function seenRecently(key, store, nowMs, windowMin) {
  const windowMs = (windowMin || 10) * 60000;
  for (const k of Object.keys(store)) {
    if (nowMs - store[k] > windowMs) delete store[k];
  }
  if (store[key] !== undefined) return true;
  store[key] = nowMs;
  return false;
}

// contacts: existing CRM contacts [{ id, email }]. selfId: the contact that triggered the run, if it exists already.
function contactDecision(lead, contacts, selfId) {
  const e = normEmail(lead.email);
  if (!e) return { action: 'reject', reason: 'invalid_email' };
  if (isDisposable(e.domain)) return { action: 'reject', reason: 'disposable_email' };
  const match = (contacts || []).find((c) => {
    if (selfId && String(c.id) === String(selfId)) return false;
    const n = normEmail(c.email);
    return n && n.email === e.email;
  });
  return match
    ? { action: 'merge', keepId: String(match.id), mergeId: selfId ? String(selfId) : null, reason: 'same_normalized_email' }
    : { action: 'keep', reason: 'no_duplicate' };
}

// The company domain a lead points to: the email domain, or the website when the email is free mail.
function leadDomain(lead) {
  const e = normEmail(lead.email);
  const emailDomain = e && !isFreeMail(e.domain) ? rootDomain(e.domain) : null;
  return emailDomain || rootDomain(lead.website || '');
}

// companies: [{ id, name, domain, otherDomains: [] }]. Exact root-domain match associates; a name-only match goes to review.
function companyDecision(lead, companies) {
  const e = normEmail(lead.email);
  const domain = leadDomain(lead);
  const list = companies || [];
  if (domain) {
    const byDomain = list.find((c) => rootDomain(c.domain) === domain || (c.otherDomains || []).some((d) => rootDomain(d) === domain));
    if (byDomain) return { action: 'associate', companyId: String(byDomain.id), domain, reason: 'domain_match' };
  }
  const name = normCompanyName(lead.company || '');
  if (name.length >= 4) {
    const candidates = list.filter((c) => {
      const n = normCompanyName(c.name || '');
      if (!n) return false;
      if (n === name) return true;
      return Math.min(n.length, name.length) >= 6 && (n.startsWith(name + ' ') || name.startsWith(n + ' '));
    });
    if (candidates.length) {
      return { action: 'review', candidateIds: candidates.map((c) => String(c.id)), domain, reason: 'name_match_only' };
    }
  }
  if (!domain) return { action: 'none', domain: null, reason: e && isFreeMail(e.domain) ? 'free_mail_no_website' : 'no_domain' };
  return { action: 'create', domain, reason: 'new_domain' };
}

module.exports = { eventKey, seenRecently, contactDecision, companyDecision, leadDomain };

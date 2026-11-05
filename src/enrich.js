'use strict';
// Clay enrichment. The workflow posts the lead to a Clay table's webhook; Clay runs its enrichment columns and an
// HTTP API column posts the result back to the n8n Wait node's resume URL. Only missing fields are asked for.

const { normCountry, normIndustry } = require('./normalize');

// Sent to Clay: what the enrichment needs to find the person and the company, nothing more.
function clayRequest(lead, domain, missing) {
  return {
    lead_key: String(lead.contactId || lead.emailNorm || ''),
    email: lead.emailNorm,
    first_name: lead.firstName,
    last_name: lead.lastName,
    company: lead.company,
    domain: domain || null,
    fields_needed: missing,
  };
}

// Clay's callback body -> the fields the score uses. Malformed values are dropped, never guessed.
function parseClay(body) {
  const e = body && typeof body === 'object' ? body.enrichment || body : null;
  if (!e || typeof e !== 'object') return null;
  const employees = Number(e.employees);
  const out = {
    country: normCountry(typeof e.country === 'string' ? e.country : ''),
    industry: typeof e.industry === 'string' ? normIndustry(e.industry) : null,
    employees: Number.isFinite(employees) && employees > 0 ? Math.round(employees) : null,
    jobTitle: typeof e.job_title === 'string' && e.job_title.trim() ? e.job_title.trim().slice(0, 120) : null,
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

module.exports = { clayRequest, parseClay };

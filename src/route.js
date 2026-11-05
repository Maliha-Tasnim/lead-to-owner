'use strict';
// Nine routing rules, checked in order; the first match wins. Every result carries a rule code and a
// plain-language reason, written back to the CRM, so any assignment can be explained and reported on.
//
//   1 non_sales_intent    support, job seekers, vendor pitches, spam and throwaway emails go to queues, never to a rep
//   2 existing_customer   customers go to their account owner
//   3 open_deal           a company with an open deal goes to the deal owner
//   4 global_account      accounts spanning two regions keep one named owner, whatever the lead's country
//   5 company_owner       a prospect company already owned by an active rep stays with that rep
//   6 departed_owner      if that owner has left: the regional team lead, plus a task to reassign the company
//   7 partner             partner and reseller enquiries go to the partner manager
//   8 region_round_robin  round robin inside the lead's region; tier A leads go to senior reps first
//   9 fallback_queue      no region or no available rep: the routing queue, with an alert
//
// Not a rule but a guard: a contact that already has an owner keeps it. Owned contacts are skipped before any
// call (pipeline.prepare); a new record that turns out to be a known, owned contact is caught here (already_owned).

const NON_SALES = { support_request: 'support', job_application: 'hr', vendor_pitch: 'discard', spam: 'discard' };

function regionOf(country, cfg) {
  if (!country) return null;
  for (const [region, countries] of Object.entries(cfg.regions)) {
    if (countries.includes(country)) return region;
  }
  return null;
}

// owners: { [ownerId]: { name, active, available, slackId } }. "active" = still a HubSpot user; "available" = not on leave.
function isActive(id, owners) {
  const o = id && owners[String(id)];
  return !!(o && o.active);
}

function isAvailable(id, owners) {
  const o = id && owners[String(id)];
  return !!(o && o.active && o.available !== false);
}

function globalOwnerFor(domains, cfg) {
  const list = (domains || []).filter(Boolean);
  for (const account of cfg.globalAccounts || []) {
    if (account.domains.some((d) => list.includes(d))) return account.ownerId;
  }
  return null;
}

// lastAssigned: { [ownerId]: ms of that rep's latest round-robin lead }, read from HubSpot. The rep whose last
// lead is oldest goes next (never assigned counts as oldest; ties keep the order in the config). There is no
// counter to keep in sync, so parallel runs, reps joining and reps coming back from leave need no special case.
function nextRep(region, tier, cfg, owners, lastAssigned) {
  const team = cfg.teams[region];
  if (!team) return null;
  let pool = team.reps.filter((id) => isAvailable(id, owners));
  if (tier === 'A') {
    const seniors = pool.filter((id) => (team.seniorReps || []).includes(id));
    if (seniors.length) pool = seniors;
  }
  if (!pool.length) return null;
  const last = lastAssigned || {};
  return pool.reduce((best, id) => ((last[id] || 0) < (last[best] || 0) ? id : best), pool[0]);
}

// ctx: { country, domain, company, companyMatch ('domain' | 'name' | null), contactOwnerId, rejectReason, classification,
//        tier, owners, cfg, lastAssigned }
// company: null or { id, name, domain, otherDomains, lifecycle, ownerId, openDealOwnerId, hqCountry }
function route(ctx) {
  const { company, classification, tier, owners, cfg } = ctx;
  const country = ctx.country || (company && company.hqCountry) || null;
  const region = regionOf(country, cfg);
  const result = (rule, ownerId, extra) => ({ rule, ownerId: ownerId ? String(ownerId) : null, queue: null, actions: [], alert: false, region, ...extra });
  // A company found by name only (no domain match) still decides the owner, but a person should confirm the match.
  const byName = (r) => (ctx.companyMatch === 'name' ? { ...r, reason: `${r.reason}. Company matched by name only, so please check` } : r);

  // 1
  if (ctx.rejectReason) {
    return result('non_sales_intent', null, { queue: 'discard', reason: `Not a lead (${ctx.rejectReason.replace(/_/g, ' ')}): sent to ${cfg.queues.discard}` });
  }
  const queue = NON_SALES[classification.intent];
  if (queue) {
    return result('non_sales_intent', null, { queue, reason: `Not a sales lead (${classification.intent.replace(/_/g, ' ')}): sent to ${cfg.queues[queue]}` });
  }

  // Guard: the new record is a duplicate of a known contact with an active owner, so that owner keeps the person.
  if (ctx.contactOwnerId && isActive(ctx.contactOwnerId, owners)) {
    return result('already_owned', ctx.contactOwnerId, { reason: 'Known contact, merged with the existing record: keeps its owner' });
  }

  if (company) {
    // 2
    if (company.lifecycle === 'customer' && isActive(company.ownerId, owners)) {
      return byName(result('existing_customer', company.ownerId, { reason: 'Existing customer: routed to their account owner' }));
    }
    // 3
    if (company.openDealOwnerId && isActive(company.openDealOwnerId, owners)) {
      return byName(result('open_deal', company.openDealOwnerId, { reason: 'The company has an open deal: routed to the deal owner' }));
    }
  }

  // 4
  const domains = [ctx.domain, company && company.domain, ...((company && company.otherDomains) || [])];
  const globalOwner = globalOwnerFor(domains, cfg);
  if (globalOwner && isActive(globalOwner, owners)) {
    return result('global_account', globalOwner, { reason: 'Global account spanning two regions: routed to its named owner, whatever the lead\'s country' });
  }

  if (company && company.ownerId) {
    // 5
    if (isActive(company.ownerId, owners)) {
      return byName(result('company_owner', company.ownerId, { reason: 'The company already has an owner: routed to the same rep' }));
    }
    // 6
    const companyRegion = regionOf(company.hqCountry, cfg) || region;
    const teamLead = companyRegion && cfg.teams[companyRegion] ? cfg.teams[companyRegion].lead : null;
    if (teamLead && isActive(teamLead, owners)) {
      return byName(result('departed_owner', teamLead, {
        region: companyRegion,
        actions: ['reassign_company'],
        alert: true,
        reason: 'The company\'s owner has left: routed to the regional team lead, with a task to reassign the company',
      }));
    }
  }

  // 7
  if (classification.intent === 'partnership' && isActive(cfg.partnerManager, owners)) {
    return result('partner', cfg.partnerManager, { reason: 'Partner or reseller enquiry: routed to the partner manager' });
  }

  // 8
  if (region) {
    const rep = nextRep(region, tier, cfg, owners, ctx.lastAssigned);
    if (rep) {
      return result('region_round_robin', rep, { reason: `Next rep in the ${region} round robin${tier === 'A' ? ' (tier A: senior reps first)' : ''}` });
    }
  }

  // 9
  return result('fallback_queue', null, {
    queue: 'routing',
    alert: true,
    reason: region ? `No available rep in ${region}: sent to the routing queue` : 'Country unknown or outside the four regions: sent to the routing queue',
  });
}

module.exports = { route, regionOf, nextRep, isActive, isAvailable, NON_SALES };

'use strict';
// Example settings for the lead-to-owner workflow. Every name, ID and number here is made up.
// Sales ops changes routing by editing this file and rebuilding the n8n workflow (npm run build),
// so nobody has to touch the logic in src/ to move a rep, a country or a score threshold.

module.exports = {
  // 'shadow' records the owner the workflow would pick (lr_routed_owner_id) without assigning it, merging
  // contacts or messaging anyone, so its choices can be compared with manual assignment before go-live.
  // 'live' assigns owners, merges duplicates and sends the Slack messages.
  mode: 'live',

  // Four sales regions. A country outside them goes to the routing queue (rule 9).
  regions: {
    NORDICS: ['FI', 'SE', 'NO', 'DK', 'IS'],
    DACH: ['DE', 'AT', 'CH'],
    UKI: ['GB', 'IE'],
    REST_OF_EUROPE: ['FR', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'PL', 'CZ', 'EE', 'LV', 'LT'],
  },

  // HubSpot owner IDs per region. Tier A leads go to senior reps first when one is available.
  teams: {
    NORDICS: { lead: '31010', reps: ['31001', '31002'], seniorReps: ['31001'] },
    DACH: { lead: '31011', reps: ['31003', '31004'], seniorReps: ['31003'] },
    UKI: { lead: '31012', reps: ['31005', '31006'], seniorReps: ['31005'] },
    REST_OF_EUROPE: { lead: '31013', reps: ['31007', '31008'], seniorReps: ['31007'] },
  },

  partnerManager: '31009',

  // Reps on leave are skipped by the round robin until sales ops removes them from this list.
  // Their own accounts stay with them while they're away; whoever covers for them works from the same owner field.
  unavailableOwners: ['31006'],

  // HubSpot owner ID -> Slack member ID, for direct messages to the new owner.
  ownerSlackIds: {
    '31001': 'U01NORD1', '31002': 'U01NORD2', '31003': 'U01DACH1', '31004': 'U01DACH2', '31005': 'U01UKI01',
    '31006': 'U01UKI02', '31007': 'U01REST1', '31008': 'U01REST2', '31009': 'U01PART1', '31010': 'U01LEADN',
    '31011': 'U01LEADD', '31012': 'U01LEADU', '31013': 'U01LEADR', '31015': 'U01GLOB1',
  },

  // Accounts that span two regions keep one named owner, matched on any of their domains (rule 4).
  globalAccounts: [
    { name: 'Brightline Utilities', domains: ['brightline-utilities.co.uk', 'brightline-utilities.nl'], ownerId: '31015' },
  ],

  // Leads that are not for a sales rep go to one of these queues (internal values of the lr_routing_queue property).
  queues: { support: 'Support desk', hr: 'Recruiting inbox', discard: 'Not a lead (reviewed weekly)', routing: 'Routing queue' },

  icp: {
    industries: ['telecommunications', 'utilities', 'energy', 'data centers'],
    adjacentIndustries: ['manufacturing', 'logistics', 'real estate', 'it services'],
  },

  score: { tierA: 70, tierB: 40 },

  // Clay is called only when a field the score or the rules need is missing, because every row costs credits.
  // If Clay hasn't answered after this many minutes, the lead is scored and routed without it.
  enrichment: { waitMinutes: 2 },

  ai: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1024, minConfidence: 0.7, maxMessageChars: 2000 },

  sla: { ownerMinutes: 5 },

  // The round robin gives the next lead to the rep whose last round-robin lead is oldest, read from HubSpot.
  roundRobinLookbackDays: 30,

  idempotencyWindowMin: 10,

  // The named set of key fields behind the completeness score written to every lead (lr_completeness_pct).
  keyFields: ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'country', 'industry', 'employees', 'owner'],

  // Slack channel ID of #sales-routing, where alerts, the watchdog and the weekly numbers are posted.
  slack: { alertChannel: 'C01ROUTING' },

  hubspotPortalUrl: 'https://app.hubspot.com/contacts/0000000',
};

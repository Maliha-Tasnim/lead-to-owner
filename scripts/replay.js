'use strict';
// npm run replay: runs the made-up leads through the workflow logic against a fake HubSpot and prints what
// happened to each one, then the numbers the Monday digest would post. Add --shadow to run in shadow mode.

const cfg = require('../src/config');
const crm = require('../src/crm');
const { weeklyDigest } = require('../src/metrics');
const { replay } = require('../test/helpers/replay');

const mode = process.argv.includes('--shadow') ? 'shadow' : 'live';
const { hub, outcomes } = replay({ ...cfg, mode });
const owners = crm.toOwners(hub.getOwners(), cfg);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

console.log(`Mode: ${mode}\n`);
console.log([pad('Lead', 5), pad('Rule', 19), pad('Owner or queue', 22), pad('Tier', 5), pad('Score', 6), pad('Clay', 11), pad('AI', 24), pad('Review', 7), 'What happened'].join(''));
for (const { lead, result } of outcomes) {
  if (result.skipped) {
    console.log([pad(lead.id, 5), pad('(skipped)', 19), pad('', 22), pad('', 5), pad('', 6), pad('', 11), pad('', 24), pad('', 7), `${result.reason}: ${lead.label}`].join(''));
    continue;
  }
  const r = result.routing;
  const who = r.ownerId ? (owners[r.ownerId] || {}).name || r.ownerId : `queue: ${r.queue}`;
  console.log([
    pad(lead.id, 5), pad(r.rule, 19), pad(who, 22), pad(result.scored.score.tier, 5), pad(result.scored.score.total, 6),
    pad(result.scored.enrichmentStatus, 11), pad(result.classification.source === 'ai' ? result.classification.intent : `fallback:${result.classification.intent}`, 24),
    pad(result.properties.lr_needs_review === 'true' ? 'yes' : '', 7), lead.label,
  ].join(''));
}

const now = new Date('2026-11-05T09:30:00Z').getTime();
const digest = weeklyDigest(crm.toDigestRows(hub.search('contacts', crm.digestBody(now))), cfg);
console.log('\nWeekly numbers from the same data:');
console.log(JSON.stringify(digest, null, 2));
const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const w = hub.writes;
console.log(`\nWrites: ${n(w.updates.length, 'contact update')}, ${n(w.slack.length, 'Slack message')}, ${n(w.tasks.length, 'task')}, ${n(w.merges.length, 'merge')}, ${n(w.associations.length, 'company link')}.`);

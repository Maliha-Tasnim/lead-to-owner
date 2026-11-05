'use strict';
// The numbers that show whether the workflow works:
//  - routing time: intake to routed, per lead, with the share inside the 5-minute target;
//  - a watchdog list of leads the workflow never finished and nobody owns after 5 minutes (checked every 5 minutes);
//  - completeness: the fill rate of a named set of key fields, written to every lead and averaged weekly.

function minutesBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60000 : null;
}

// Nearest-rank percentile on a sorted list.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

// rows: [{ intakeAt, routedAt }]
function routingStats(rows, cfg) {
  const mins = (rows || []).map((r) => minutesBetween(r.intakeAt, r.routedAt)).filter((m) => m !== null && m >= 0).sort((a, b) => a - b);
  if (!mins.length) return { count: 0, median: null, p90: null, withinTarget: null };
  const within = mins.filter((m) => m <= cfg.sla.ownerMinutes).length;
  return { count: mins.length, median: percentile(mins, 0.5), p90: percentile(mins, 0.9), withinTarget: within / mins.length };
}

// rows: [{ id, name, intakeAt, ownerId, routedAt }]. A lead the workflow routed (to a rep or a queue, live or
// shadow) is not late, and neither is one a person already owns.
function watchdog(rows, nowMs, cfg) {
  return (rows || [])
    .filter((r) => !r.ownerId && !r.routedAt)
    .map((r) => ({ ...r, minutesWaiting: (nowMs - new Date(r.intakeAt).getTime()) / 60000 }))
    .filter((r) => Number.isFinite(r.minutesWaiting) && r.minutesWaiting > cfg.sla.ownerMinutes)
    .sort((a, b) => b.minutesWaiting - a.minutesWaiting)
    .map((r) => ({ contactId: String(r.id), name: r.name || '', minutesWaiting: Math.round(r.minutesWaiting) }));
}

function isFilled(v) {
  return !(v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
}

function recordCompleteness(record, keyFields) {
  const missing = keyFields.filter((f) => !isFilled(record[f]));
  const filled = keyFields.length - missing.length;
  return { filled, total: keyFields.length, rate: keyFields.length ? filled / keyFields.length : 1, missing };
}

// rows: [{ intakeAt, routedAt, rule, ownerId, completenessPct, needsReview }] for one week. A lead that already had
// an owner when it came in was skipped on purpose, so it is counted apart from leads the workflow missed.
function weeklyDigest(rows, cfg) {
  const list = rows || [];
  const byRule = {};
  for (const r of list) {
    const key = r.rule || (r.ownerId ? 'owned_before_intake' : 'not_routed');
    byRule[key] = (byRule[key] || 0) + 1;
  }
  const pcts = list.filter((r) => r.completenessPct !== null && r.completenessPct !== undefined && r.completenessPct !== '')
    .map((r) => Number(r.completenessPct)).filter((n) => Number.isFinite(n));
  return {
    leads: list.length,
    routing: routingStats(list.filter((r) => r.routedAt), cfg),
    notRouted: list.filter((r) => !r.routedAt && !r.ownerId).length,
    byRule,
    avgCompletenessPct: pcts.length ? Math.round(pcts.reduce((s, n) => s + n, 0) / pcts.length) : null,
    needsReview: list.filter((r) => r.needsReview).length,
  };
}

// The watchdog runs every 5 minutes; each stuck lead is reported once, not every 5 minutes for a day.
// store: plain object kept between runs (n8n: workflow static data), pruned after 24 hours.
function firstAlerts(late, store, nowMs) {
  for (const [id, t] of Object.entries(store)) {
    if (nowMs - t > 86400000) delete store[id];
  }
  const fresh = (late || []).filter((l) => store[l.contactId] === undefined);
  for (const l of fresh) store[l.contactId] = nowMs;
  return fresh;
}

function watchdogText(late, cfg) {
  const lines = late.slice(0, 10).map((l) => `- ${l.name || 'Unnamed lead'}: waiting ${l.minutesWaiting} min <${cfg.hubspotPortalUrl}/record/0-1/${l.contactId}|open>`);
  const more = late.length > 10 ? `\n...and ${late.length - 10} more.` : '';
  return `${late.length} lead${late.length === 1 ? '' : 's'} not routed and without an owner after ${cfg.sla.ownerMinutes} minutes:\n${lines.join('\n')}${more}`;
}

function digestText(d, cfg, truncated) {
  const num = (x) => (x === null || x === undefined ? 'n/a' : String(Math.round(x * 10) / 10));
  const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
  const rules = Object.entries(d.byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `Lead routing, last 7 days: ${d.leads} lead${d.leads === 1 ? '' : 's'}${truncated ? ' (the latest 200 only; the HubSpot report has them all)' : ''}.`,
    `Time to owner or queue: median ${num(d.routing.median)} min, p90 ${num(d.routing.p90)} min, ${pct(d.routing.withinTarget)} within ${cfg.sla.ownerMinutes} minutes.`,
    `Missed by the workflow: ${d.notRouted}. Flagged for review: ${d.needsReview}. Key fields filled: ${d.avgCompletenessPct === null ? 'n/a' : `${d.avgCompletenessPct}%`} on average.`,
    `By rule: ${rules || 'none'}.`,
  ].join('\n');
}

module.exports = { minutesBetween, percentile, routingStats, watchdog, recordCompleteness, weeklyDigest, firstAlerts, watchdogText, digestText };

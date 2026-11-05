'use strict';
// Fit + engagement lead score (0 to 100). Fit says "is this our kind of customer?" (0 to 60);
// engagement says "are they buying now?" (0 to 40). Every point carries a reason code, so a rep
// can see why a lead is tier A and sales ops can tune the weights against closed-won data.

const { stripAccents } = require('./normalize');

const SENIORITY = [
  [/\b(ceo|cto|cio|coo|cfo|chief|founder|owner|president|managing director|toimitusjohtaja)\b/, 15],
  [/\b(vp|vice president|head of|director|johtaja)\b/, 13],
  [/\b(manager|lead|principal|paallikko)\b/, 10],
  [/\b(engineer|specialist|analyst|architect|consultant|asiantuntija)\b/, 6],
  [/\b(student|intern|trainee|harjoittelija)\b/, 0],
];

const FORM_POINTS = { demo_request: 20, pricing: 15, contact: 10, content_download: 5, webinar_signup: 5, newsletter: 2 };

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sum(parts) {
  return parts.reduce((s, p) => s + p[1], 0);
}

// profile: { industry, employees, region, jobTitle, freeMail }
function fitScore(profile, cfg) {
  const p = profile || {};
  const parts = [];
  const industry = String(p.industry || '').toLowerCase();
  if (cfg.icp.industries.includes(industry)) parts.push(['industry_icp', 20]);
  else if (cfg.icp.adjacentIndustries.includes(industry)) parts.push(['industry_adjacent', 10]);
  const emp = Number(p.employees);
  if (emp >= 1000) parts.push(['employees_1000_plus', 15]);
  else if (emp >= 200) parts.push(['employees_200_999', 12]);
  else if (emp >= 50) parts.push(['employees_50_199', 8]);
  else if (emp > 0) parts.push(['employees_1_49', 3]);
  if (p.region) parts.push(['region_served', 10]);
  const title = stripAccents(String(p.jobTitle || '').toLowerCase());
  for (const [re, pts] of SENIORITY) {
    if (re.test(title)) {
      if (pts) parts.push(['title_seniority', pts]);
      break;
    }
  }
  if (p.freeMail) parts.push(['free_mail', -10]);
  return { total: clamp(sum(parts), 0, 60), parts };
}

// activity: { formType, pricingPageViews, webinarAttended, emailClicks30d, lastActivityAt }
// The form just submitted counts in full. The older signals lose weight with the time since the last activity
// before it, and the loss shows up as its own reason, so a rep can see why a busy-looking lead scored low.
function engagementScore(activity, nowMs) {
  const a = activity || {};
  const parts = [];
  if (FORM_POINTS[a.formType]) parts.push(['form_' + a.formType, FORM_POINTS[a.formType]]);
  const older = [];
  const views = Math.min(Number(a.pricingPageViews) || 0, 3);
  if (views > 0) older.push(['pricing_page_views', views * 2]);
  if (a.webinarAttended === true || a.webinarAttended === 'true') older.push(['webinar_attended', 5]);
  const clicks = Math.min(Number(a.emailClicks30d) || 0, 5);
  if (clicks > 0) older.push(['email_clicks_30d', clicks]);
  const last = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : nowMs;
  const days = Number.isFinite(last) ? Math.max(0, (nowMs - last) / 86400000) : 0;
  const decay = days <= 7 ? 1 : days <= 30 ? 0.7 : days <= 90 ? 0.4 : 0.2;
  parts.push(...older);
  const kept = Math.round(sum(older) * decay);
  if (kept < sum(older)) parts.push(['older_activity_decay', kept - sum(older)]);
  return { total: clamp(sum(parts), 0, 40), parts, decay };
}

function scoreLead(profile, activity, nowMs, cfg) {
  const fit = fitScore(profile, cfg);
  const engagement = engagementScore(activity, nowMs);
  const total = fit.total + engagement.total;
  const tier = total >= cfg.score.tierA ? 'A' : total >= cfg.score.tierB ? 'B' : 'C';
  return { total, tier, fit, engagement };
}

module.exports = { fitScore, engagementScore, scoreLead, FORM_POINTS };

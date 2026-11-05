'use strict';
// Normalization helpers shared by every step. Pure functions: no network, no clock, easy to test.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'mail.com', 'zoho.com', 'yandex.com', 'luukku.com', 'suomi24.fi',
]);

const DISPOSABLE = new Set(['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com']);

// Public suffixes with two labels, so "brightline-utilities.co.uk" keeps three labels as its root domain.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
  'com.br', 'com.mx', 'co.za', 'com.sg', 'com.tr', 'co.in',
]);

// Legal-form endings removed before company names are compared ("Kestrel Metering Oy" = "Kestrel Metering").
const LEGAL_SUFFIXES = [
  'oyj', 'oy', 'ab', 'asa', 'as', 'a/s', 'aps', 'gmbh', 'ag', 'kg', 'ltd', 'limited', 'plc', 'inc', 'incorporated',
  'llc', 'corp', 'corporation', 'bv', 'nv', 'sa', 'sas', 'sarl', 'srl', 'spa', 'ou', 'kft', 'ky', 'tmi', 'group',
];

const COUNTRIES = {
  finland: 'FI', suomi: 'FI', sweden: 'SE', sverige: 'SE', norway: 'NO', norge: 'NO', denmark: 'DK', danmark: 'DK',
  iceland: 'IS', germany: 'DE', deutschland: 'DE', austria: 'AT', osterreich: 'AT', switzerland: 'CH', schweiz: 'CH',
  suisse: 'CH', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'northern ireland': 'GB', ireland: 'IE', france: 'FR', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL',
  belgium: 'BE', luxembourg: 'LU', spain: 'ES', portugal: 'PT', italy: 'IT', poland: 'PL', czechia: 'CZ',
  'czech republic': 'CZ', estonia: 'EE', latvia: 'LV', lithuania: 'LT', 'united states': 'US', usa: 'US',
  brazil: 'BR', india: 'IN', canada: 'CA', australia: 'AU', japan: 'JP',
};

function stripAccents(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

// "John.Smith+promo@GoogleMail.com" -> "johnsmith@gmail.com". Returns null for anything that isn't an email.
function normEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const m = /^([^\s@]+)@([a-z0-9.-]+\.[a-z]{2,})$/.exec(s);
  if (!m) return null;
  let local = m[1].split('+')[0];
  let domain = m[2];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return { email: `${local}@${domain}`, local, domain };
}

// "https://www.Kestrelmetering.com/contact" -> "kestrelmetering.com"; "mail.brightline-utilities.co.uk" -> "brightline-utilities.co.uk".
function rootDomain(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0];
  host = host.split('@').pop();
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels[0] === 'www') labels.shift();
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function isFreeMail(domain) {
  return FREE_MAIL.has(String(domain || '').toLowerCase());
}

function isDisposable(domain) {
  return DISPOSABLE.has(String(domain || '').toLowerCase());
}

// "Kestrel Metering Oy" and "KESTREL METERING" both become "kestrel metering".
function normCompanyName(name) {
  if (typeof name !== 'string') return '';
  let s = stripAccents(name.toLowerCase()).replace(/&/g, ' and ').replace(/\./g, '');
  s = s.replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s !== suffix && s.endsWith(' ' + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

// "Suomi", "finland", "FI" -> "FI". Unknown values return null rather than a guess.
function normCountry(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = stripAccents(raw.trim().toLowerCase()).replace(/\./g, '');
  if (COUNTRIES[key]) return COUNTRIES[key];
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}

// HubSpot industry codes ("OIL_ENERGY") and Clay or LinkedIn industry names ("Renewable Energy Power Generation")
// mapped to the short list the score uses. Order matters: the first match wins. Unknown values pass through.
const INDUSTRY_RULES = [
  ['data centers', /data ?cent(er|re)s?/],
  ['telecommunications', /telecom|wireless|internet service|\bisp\b/],
  ['utilities', /utilit|water supply|district heating/],
  ['energy', /energy|power|electric|oil|gas\b|renewable/],
  ['manufacturing', /manufactur|machinery|industrial|semiconductor/],
  ['logistics', /logistic|supply chain|transport|freight|shipping/],
  ['real estate', /real estate|property|facilit/],
  ['it services', /information technology|it services|software|computer|internet/],
];

function normIndustry(raw) {
  if (raw === null || raw === undefined) return null;
  const s = stripAccents(String(raw).toLowerCase().replace(/_/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const [name, re] of INDUSTRY_RULES) {
    if (re.test(s)) return name;
  }
  return s;
}

// 32-bit FNV-1a, so idempotency keys work inside an n8n Code node without the crypto module.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { normEmail, rootDomain, isFreeMail, isDisposable, normCompanyName, normCountry, normIndustry, fnv1a, stripAccents };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/normalize');

test('normEmail lowercases, strips +tags and folds Gmail variants', () => {
  assert.equal(n.normEmail('Ingrid.Berg+webinar@FjordNett.no').email, 'ingrid.berg@fjordnett.no');
  assert.equal(n.normEmail(' J.O.H.N+x@googlemail.com ').email, 'john@gmail.com');
  assert.equal(n.normEmail('first.last@company.com').email, 'first.last@company.com', 'dots only matter outside Gmail');
  assert.equal(n.normEmail('not an email'), null);
  assert.equal(n.normEmail('@nodomain.com'), null);
  assert.equal(n.normEmail('+only@example.com'), null);
  assert.equal(n.normEmail(42), null);
});

test('rootDomain handles protocols, paths, ports, www and two-level suffixes', () => {
  assert.equal(n.rootDomain('https://www.Kestrelmetering.com/contact?x=1'), 'kestrelmetering.com');
  assert.equal(n.rootDomain('mail.brightline-utilities.co.uk'), 'brightline-utilities.co.uk');
  assert.equal(n.rootDomain('portal.eu.example.com:8443'), 'example.com');
  assert.equal(n.rootDomain('someone@sub.example.fi'), 'example.fi');
  assert.equal(n.rootDomain('localhost'), null);
  assert.equal(n.rootDomain(''), null);
});

test('normCompanyName removes legal forms, accents and punctuation', () => {
  assert.equal(n.normCompanyName('Kestrel Metering Oy'), 'kestrel metering');
  assert.equal(n.normCompanyName('KESTREL METERING'), 'kestrel metering');
  assert.equal(n.normCompanyName('Brightline Utilities B.V.'), 'brightline utilities');
  assert.equal(n.normCompanyName('Fjord & Sons AS'), 'fjord and sons');
  assert.equal(n.normCompanyName('Müller Energie GmbH'), 'muller energie');
  assert.equal(n.normCompanyName('Nordic Holding Group AB'), 'nordic holding');
  assert.equal(n.normCompanyName('Group'), 'group', 'a name that is only a legal word stays');
});

test('normCountry maps names and codes to ISO codes and never guesses', () => {
  assert.equal(n.normCountry('Suomi'), 'FI');
  assert.equal(n.normCountry('finland'), 'FI');
  assert.equal(n.normCountry('fi'), 'FI');
  assert.equal(n.normCountry('U.K.'), 'GB');
  assert.equal(n.normCountry('Österreich'), 'AT');
  assert.equal(n.normCountry('Atlantis'), null);
  assert.equal(n.normCountry(''), null);
});

test('normIndustry maps HubSpot codes and Clay names to the scoring list', () => {
  assert.equal(n.normIndustry('OIL_ENERGY'), 'energy');
  assert.equal(n.normIndustry('TELECOMMUNICATIONS'), 'telecommunications');
  assert.equal(n.normIndustry('Wireless Services'), 'telecommunications');
  assert.equal(n.normIndustry('Electric Utilities'), 'utilities');
  assert.equal(n.normIndustry('Data Centers'), 'data centers');
  assert.equal(n.normIndustry('IT Services and IT Consulting'), 'it services');
  assert.equal(n.normIndustry('Renewable Energy Semiconductor Manufacturing'), 'energy');
  assert.equal(n.normIndustry('Biotechnology'), 'biotechnology');
  assert.equal(n.normIndustry(''), null);
  assert.equal(n.normIndustry(null), null);
});

test('free-mail and disposable lists', () => {
  assert.ok(n.isFreeMail('gmail.com'));
  assert.ok(!n.isFreeMail('kestrelmetering.com'));
  assert.ok(n.isDisposable('MAILINATOR.COM'));
});

test('fnv1a gives stable 8-character keys', () => {
  assert.equal(n.fnv1a(''), '811c9dc5');
  assert.equal(n.fnv1a('a'), 'e40c292c');
  assert.equal(n.fnv1a('lead|form|1'), n.fnv1a('lead|form|1'));
});

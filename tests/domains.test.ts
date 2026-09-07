import { describe, it, expect } from 'vitest';
import { registrableDomainOf, isThirdParty, cookieDomainToRegistrable, hostnameOf } from '../src/util/domains.js';

describe('first-party vs third-party classification', () => {
  it('uses the registrable domain (eTLD+1), not the hostname', () => {
    expect(registrableDomainOf('https://www.spellingoefenen.nl/oefenen.html')).toBe('spellingoefenen.nl');
    expect(registrableDomainOf('https://js.spellingoefenen.nl/x.js')).toBe('spellingoefenen.nl');
    expect(isThirdParty('https://js.spellingoefenen.nl/x.js', 'spellingoefenen.nl')).toBe(false);
    expect(isThirdParty('https://securepubads.g.doubleclick.net/x', 'spellingoefenen.nl')).toBe(true);
  });

  it('handles multi-label public suffixes', () => {
    expect(registrableDomainOf('https://foo.bar.co.uk/x')).toBe('bar.co.uk');
  });

  it('treats non-network schemes as first party rather than unknown', () => {
    expect(isThirdParty('data:image/png;base64,AA', 'example.nl')).toBe(false);
    expect(isThirdParty('about:blank', 'example.nl')).toBe(false);
  });

  it('returns null when no comparison is possible instead of guessing', () => {
    expect(isThirdParty('https://example.com/', null)).toBeNull();
  });

  it('normalises dotted cookie domains', () => {
    expect(cookieDomainToRegistrable('.doubleclick.net')).toBe('doubleclick.net');
    expect(cookieDomainToRegistrable('www.spellingoefenen.nl')).toBe('spellingoefenen.nl');
  });

  it('parses fixture test hostnames', () => {
    expect(hostnameOf('http://tracker.third-party.test/x')).toBe('tracker.third-party.test');
    expect(isThirdParty('http://tracker.third-party.test/x', 'first-party.test')).toBe(true);
    expect(isThirdParty('http://first-party.test/x', 'first-party.test')).toBe(false);
  });
});

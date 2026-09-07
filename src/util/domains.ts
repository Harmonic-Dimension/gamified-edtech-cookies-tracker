import { parse } from 'tldts';

export interface DomainInfo {
  hostname: string | null;
  registrableDomain: string | null;
  isIp: boolean;
}

const cache = new Map<string, DomainInfo>();

export function domainInfo(url: string): DomainInfo {
  const cached = cache.get(url);
  if (cached) return cached;
  let info: DomainInfo;
  try {
    const parsed = parse(url, { allowPrivateDomains: false });
    info = {
      hostname: parsed.hostname,
      registrableDomain: parsed.domain ?? (parsed.isIp ? parsed.hostname : null),
      isIp: Boolean(parsed.isIp),
    };
  } catch {
    info = { hostname: null, registrableDomain: null, isIp: false };
  }
  if (cache.size < 20000) cache.set(url, info);
  return info;
}

export function hostnameOf(url: string): string | null {
  return domainInfo(url).hostname;
}

export function registrableDomainOf(url: string): string | null {
  return domainInfo(url).registrableDomain;
}

/**
 * First-party vs third-party is decided on the registrable domain (eTLD+1) of
 * the *audited site*, not on the current page URL: a request made while the
 * browser sits on an ad landing frame is still third party relative to the site
 * under audit. Returns null when the comparison cannot be made.
 */
export function isThirdParty(url: string, firstPartyRegistrableDomain: string | null): boolean | null {
  if (!firstPartyRegistrableDomain) return null;
  const target = registrableDomainOf(url);
  if (!target) {
    // data:, blob:, about: and friends are not network third parties.
    if (/^(data|blob|about|javascript|chrome|chrome-extension):/i.test(url)) return false;
    return null;
  }
  return target.toLowerCase() !== firstPartyRegistrableDomain.toLowerCase();
}

/** Cookie domains may be dotted (".example.com"); normalise before comparing. */
export function cookieDomainToRegistrable(cookieDomain: string): string | null {
  const bare = cookieDomain.replace(/^\./, '');
  return registrableDomainOf(`http://${bare}`);
}

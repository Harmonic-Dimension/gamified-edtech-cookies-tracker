import type { BrowserContext, Page } from 'playwright';
import type { StorageCheckpoint, OriginStorage, StorageEntry, StoredCookie, CookieCheckpoint } from '../types.js';
import { sha256 } from '../util/hash.js';
import { previewStorageValue } from '../util/sanitize.js';
import { cookieDomainToRegistrable } from '../util/domains.js';
import { withTimeout } from '../util/timeout.js';

/** Reads all cookies in the context; raw values are hashed, never persisted. */
export async function captureCookies(
  context: BrowserContext,
  firstPartyDomain: string,
  label: string,
  tRelMs: number,
): Promise<CookieCheckpoint> {
  // A wedged browser must not stall the whole audit.
  const raw = await withTimeout(context.cookies(), 15000, 'context.cookies()');
  const cookies: StoredCookie[] = raw.map((c) => {
    const registrable = cookieDomainToRegistrable(c.domain);
    const expires = typeof c.expires === 'number' ? c.expires : -1;
    return {
      name: c.name,
      domain: c.domain,
      registrableDomain: registrable,
      path: c.path,
      expires,
      expiresIso: expires > 0 ? new Date(expires * 1000).toISOString() : null,
      lifetimeDays: expires > 0 ? Math.round(((expires * 1000 - Date.now()) / 86400000) * 10) / 10 : null,
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite ?? null,
      hostOnly: c.domain.startsWith('.') ? false : true,
      valueLength: (c.value ?? '').length,
      valueSha256: sha256(c.value ?? ''),
      isThirdParty: registrable ? registrable.toLowerCase() !== firstPartyDomain.toLowerCase() : null,
    };
  });
  return { label, tRelMs, cookies };
}

interface RawStorage {
  origin: string;
  localStorage: Array<{ key: string; value: string }> | null;
  sessionStorage: Array<{ key: string; value: string }> | null;
  indexedDbDatabases: string[] | null;
  cacheStorageKeys: string[] | null;
}

/**
 * Reads browser storage for every frame we can reach. Cross-origin frames throw
 * on access; that is recorded as an error for the origin rather than as "empty".
 */
export async function captureStorage(
  context: BrowserContext,
  pages: Page[],
  label: string,
  tRelMs: number,
): Promise<StorageCheckpoint> {
  const origins: OriginStorage[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      const url = frame.url();
      if (!url || url === 'about:blank' || !/^https?:/i.test(url)) continue;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        continue;
      }
      if (seen.has(origin)) continue;
      seen.add(origin);
      try {
        // NOTE: this function is serialised into the page. It deliberately
        // contains no named inner functions, because the TypeScript runner's
        // "keep names" transform would inject a helper that does not exist
        // inside the browser context.
        // page.evaluate has no timeout of its own: a busy or blocked frame
        // would otherwise hang this call indefinitely.
        const raw: RawStorage = await withTimeout(frame.evaluate(async () => {
          let local: Array<{ key: string; value: string }> | null = null;
          let session: Array<{ key: string; value: string }> | null = null;
          try {
            local = [];
            for (let i = 0; i < window.localStorage.length; i++) {
              const key = window.localStorage.key(i);
              if (key == null) continue;
              local.push({ key, value: window.localStorage.getItem(key) ?? '' });
            }
          } catch {
            local = null;
          }
          try {
            session = [];
            for (let i = 0; i < window.sessionStorage.length; i++) {
              const key = window.sessionStorage.key(i);
              if (key == null) continue;
              session.push({ key, value: window.sessionStorage.getItem(key) ?? '' });
            }
          } catch {
            session = null;
          }
          let databases: string[] | null = null;
          try {
            if (window.indexedDB && typeof indexedDB.databases === 'function') {
              const dbs = await indexedDB.databases();
              databases = [];
              for (const db of dbs) if (db.name) databases.push(db.name);
            }
          } catch {
            databases = null;
          }
          let cacheKeys: string[] | null = null;
          try {
            if (window.caches && typeof caches.keys === 'function') {
              cacheKeys = await caches.keys();
            }
          } catch {
            cacheKeys = null;
          }
          return {
            origin: location.origin,
            localStorage: local,
            sessionStorage: session,
            indexedDbDatabases: databases,
            cacheStorageKeys: cacheKeys,
          };
        }), 15000, `storage probe for ${origin}`);
        origins.push({
          origin,
          localStorage: toEntries(raw.localStorage),
          sessionStorage: toEntries(raw.sessionStorage),
          indexedDbDatabases: raw.indexedDbDatabases ?? null,
          cacheStorageKeys: raw.cacheStorageKeys ?? null,
          error: null,
        });
      } catch (err) {
        origins.push({
          origin,
          localStorage: null,
          sessionStorage: null,
          indexedDbDatabases: null,
          cacheStorageKeys: null,
          error: `not readable: ${String(err).slice(0, 200)}`,
        });
      }
    }
  }
  const serviceWorkers = context.serviceWorkers().map((worker) => worker.url());
  return { label, tRelMs, origins, serviceWorkers };
}

function toEntries(items: Array<{ key: string; value: string }> | null): StorageEntry[] | null {
  if (!items) return null;
  return items.map((item) => ({
    key: item.key,
    valueLength: item.value?.length ?? 0,
    valueSha256: sha256(item.value ?? ''),
    valuePreview: previewStorageValue(item.value ?? ''),
  }));
}

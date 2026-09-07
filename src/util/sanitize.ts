import { sha256 } from './hash.js';

/**
 * Sanitization layer.
 *
 * The audit must not create a new privacy problem of its own, and exported
 * evidence is meant to be shareable. We therefore remove values that plausibly
 * carry identifiers, while preserving *structure* (which parameter existed, how
 * long its value was, and a stable hash so that repeated appearances of the same
 * value can still be correlated across a run).
 */

/** Query/fragment parameter names whose values are replaced by a hash. */
export const SENSITIVE_PARAM_PATTERNS: RegExp[] = [
  /(^|_|-|\.)(uid|uuid|guid|gid|cid|sid|ssid|did|idfa|adid|aid|pid|tid|vid|uu|u)$/i,
  /(id|identifier)$/i,
  /^(gdpr_consent|consent|tc_?string|us_privacy|gpp|gpp_sid)$/i,
  /(token|auth|session|sess|password|passwd|secret|signature|sig|hash|key|apikey|api_key)/i,
  /(email|e_mail|mail|phone|tel|name|user|login|account)/i,
  /^(cookie|cookies|_ga|_gid|ga_|fbp|fbc|fbclid|gclid|msclkid|wbraid|gbraid|ttclid)/i,
  /^(cb|cachebuster|correlator|rnd|random|nonce)$/i,
];

/** Headers that are dropped or hashed entirely. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

const PLACEHOLDER = (kind: string, value: string) =>
  `<${kind}:len=${value.length},sha256=${sha256(value).slice(0, 16)}>`;

/**
 * URL-safe variant. URLSearchParams percent-encodes anything unusual, which
 * would make sanitized URLs unreadable in the HAR and in the dashboard, so the
 * placeholder inside a URL uses only unreserved characters.
 */
const URL_PLACEHOLDER = (kind: string, value: string) =>
  `${kind}.len${value.length}.sha256-${sha256(value).slice(0, 16)}`;

export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAM_PATTERNS.some((re) => re.test(name));
}

/**
 * Sanitize a URL: keep scheme, host, path and parameter *names*; replace values
 * that look identifying. Very long values are always replaced regardless of the
 * parameter name, because long opaque blobs are the usual shape of an identifier
 * or an encoded bid request.
 */
export function sanitizeUrl(rawUrl: string, opts: { maxValueLength?: number } = {}): string {
  const maxValueLength = opts.maxValueLength ?? 64;
  if (!rawUrl) return rawUrl;
  if (/^data:/i.test(rawUrl)) {
    const comma = rawUrl.indexOf(',');
    const meta = comma >= 0 ? rawUrl.slice(0, comma) : rawUrl.slice(0, 40);
    return `${meta},${PLACEHOLDER('data', rawUrl)}`;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.length > 300 ? `${rawUrl.slice(0, 200)}${PLACEHOLDER('truncated', rawUrl)}` : rawUrl;
  }
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  const params = url.searchParams;
  for (const key of [...params.keys()]) {
    const values = params.getAll(key);
    params.delete(key);
    for (const value of values) {
      if (!value) {
        params.append(key, value);
      } else if (isSensitiveParam(key) || value.length > maxValueLength) {
        params.append(key, URL_PLACEHOLDER('redacted', value));
      } else {
        params.append(key, value);
      }
    }
  }
  if (url.hash && url.hash.length > 2) {
    const frag = url.hash.slice(1);
    if (frag.length > maxValueLength || /=/.test(frag)) {
      url.hash = `#${URL_PLACEHOLDER('redacted', frag)}`;
    }
  }
  return url.toString();
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    out[name] = SENSITIVE_HEADERS.has(lower) ? PLACEHOLDER('redacted', value ?? '') : value;
  }
  return out;
}

/** Cookie values are never persisted raw. */
export function sanitizeCookieValue(value: string): { valueLength: number; valueSha256: string } {
  return { valueLength: value?.length ?? 0, valueSha256: sha256(value ?? '') };
}

/**
 * Storage values: keep a short preview only when the value is short and looks
 * like a plain setting ("nl", "true", "groep5"). Anything longer, anything with
 * unusual characters, and anything with the shape of an opaque token
 * (letters mixed with digits over some length) is withheld and only kept as a
 * length plus a hash.
 */
export function previewStorageValue(value: string): string | null {
  if (value == null) return null;
  if (value.length === 0) return '';
  if (value.length > 20) return null;
  if (!/^[\w .,:;+/-]+$/.test(value)) return null;
  const mixedToken = value.length >= 12 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
  const longNumber = /^\d{9,}$/.test(value); // timestamps and numeric ids
  if (mixedToken || longNumber) return null;
  return value;
}

/**
 * Sanitize a HAR file in place on disk-loaded object form. Playwright writes the
 * HAR after the context closes, so this runs as a post-processing pass.
 */
export function sanitizeHarObject(har: any): any {
  const entries = har?.log?.entries ?? [];
  for (const entry of entries) {
    if (entry.request) {
      entry.request.url = sanitizeUrl(entry.request.url ?? '');
      entry.request.headers = sanitizeHarHeaders(entry.request.headers);
      entry.request.cookies = (entry.request.cookies ?? []).map(sanitizeHarCookie);
      if (entry.request.queryString) {
        entry.request.queryString = entry.request.queryString.map((q: any) => ({
          name: q.name,
          value: isSensitiveParam(q.name ?? '') || (q.value ?? '').length > 64
            ? URL_PLACEHOLDER('redacted', q.value ?? '')
            : q.value,
        }));
      }
      if (entry.request.postData?.text) {
        entry.request.postData.text = PLACEHOLDER('post-body', entry.request.postData.text);
        delete entry.request.postData.params;
      }
    }
    if (entry.response) {
      entry.response.headers = sanitizeHarHeaders(entry.response.headers);
      entry.response.cookies = (entry.response.cookies ?? []).map(sanitizeHarCookie);
      if (entry.response.redirectURL) entry.response.redirectURL = sanitizeUrl(entry.response.redirectURL);
      // Response bodies can contain arbitrary personal data and bloat exports.
      if (entry.response.content) {
        const mime = entry.response.content.mimeType ?? '';
        if (entry.response.content.text && !/^(image|font)\//.test(mime)) {
          entry.response.content.text = PLACEHOLDER('body', entry.response.content.text);
        } else if (entry.response.content.text) {
          delete entry.response.content.text;
        }
      }
    }
    if (entry.pageref) entry.pageref = String(entry.pageref);
  }
  for (const page of har?.log?.pages ?? []) {
    if (page.title) page.title = sanitizeUrl(page.title);
  }
  return har;
}

function sanitizeHarHeaders(headers: any[]): any[] {
  return (headers ?? []).map((h) => ({
    name: h.name,
    value: SENSITIVE_HEADERS.has((h.name ?? '').toLowerCase())
      ? PLACEHOLDER('redacted', h.value ?? '')
      : h.value,
  }));
}

function sanitizeHarCookie(cookie: any): any {
  return {
    ...cookie,
    value: PLACEHOLDER('cookie', cookie?.value ?? ''),
  };
}

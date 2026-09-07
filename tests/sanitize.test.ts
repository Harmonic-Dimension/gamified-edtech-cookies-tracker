import { describe, it, expect } from 'vitest';
import {
  sanitizeUrl,
  sanitizeHeaders,
  sanitizeCookieValue,
  sanitizeHarObject,
  previewStorageValue,
  isSensitiveParam,
} from '../src/util/sanitize.js';
import { sha256 } from '../src/util/hash.js';

describe('URL sanitization', () => {
  it('keeps host, path and parameter names but removes identifier values', () => {
    const url = 'https://ads.example.com/bid?uid=abc123def456&size=300x250&gdpr_consent=CPxyz';
    const sanitized = sanitizeUrl(url);
    expect(sanitized).toContain('ads.example.com/bid');
    expect(sanitized).toContain('size=300x250');
    expect(sanitized).not.toContain('abc123def456');
    expect(sanitized).not.toContain('CPxyz');
    expect(sanitized).toContain('uid=');
  });

  it('redacts long opaque values even when the parameter name looks harmless', () => {
    const long = 'a'.repeat(120);
    const sanitized = sanitizeUrl(`https://example.com/x?payload=${long}`);
    expect(sanitized).not.toContain(long);
    expect(sanitized).toContain('len120');
  });

  it('produces a stable hash so repeated identifiers stay correlatable', () => {
    const first = sanitizeUrl('https://example.com/x?uid=samevalue1234567');
    const second = sanitizeUrl('https://example.com/y?uid=samevalue1234567');
    const hash = sha256('samevalue1234567').slice(0, 16);
    expect(first).toContain(hash);
    expect(second).toContain(hash);
  });

  it('strips credentials from the URL', () => {
    expect(sanitizeUrl('https://user:secret@example.com/path')).not.toContain('secret');
  });

  it('does not choke on data: and malformed URLs', () => {
    expect(sanitizeUrl('data:image/png;base64,AAAA')).toContain('data:image/png;base64');
    expect(sanitizeUrl('https://example.com/x?uid=abcdefghijklmnop')).not.toContain('%3C');
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });

  it('recognises identifier-like parameter names', () => {
    expect(isSensitiveParam('session_token')).toBe(true);
    expect(isSensitiveParam('user_id')).toBe(true);
    expect(isSensitiveParam('width')).toBe(false);
  });
});

describe('header and cookie sanitization', () => {
  it('redacts authorization and cookie headers', () => {
    const headers = sanitizeHeaders({ Authorization: 'Bearer abc', Cookie: 'a=b', 'Content-Type': 'text/html' });
    expect(headers.Authorization).not.toContain('abc');
    expect(headers.Cookie).not.toContain('a=b');
    expect(headers['Content-Type']).toBe('text/html');
  });

  it('never returns the raw cookie value', () => {
    const result = sanitizeCookieValue('super-secret-identifier');
    expect(result.valueLength).toBe('super-secret-identifier'.length);
    expect(result.valueSha256).toBe(sha256('super-secret-identifier'));
    expect(JSON.stringify(result)).not.toContain('super-secret-identifier');
  });

  it('withholds storage previews that look like identifiers', () => {
    expect(previewStorageValue('nl')).toBe('nl');
    expect(previewStorageValue('groep5')).toBe('groep5');
    expect(previewStorageValue('a'.repeat(80))).toBeNull();
    expect(previewStorageValue('eyJhbGciOiJIUzI1NiJ9abcdef')).toBeNull();
    expect(previewStorageValue('a1b2c3d4e5f6g7')).toBeNull();
    expect(previewStorageValue('{"id":"x"}')).toBeNull();
    expect(previewStorageValue('1788708549540')).toBeNull();
    expect(previewStorageValue('42')).toBe('42');
  });
});

describe('HAR sanitization', () => {
  it('removes cookie values, auth headers and bodies but keeps structure', () => {
    const har = {
      log: {
        pages: [{ title: 'https://example.com/?token=abcdefghijklmnop' }],
        entries: [
          {
            request: {
              url: 'https://tracker.example/collect?uid=identifier1234567',
              headers: [{ name: 'Authorization', value: 'Bearer xyz' }],
              cookies: [{ name: 'sid', value: 'secretvalue' }],
              queryString: [{ name: 'uid', value: 'identifier1234567' }],
              postData: { text: 'name=child&score=10' },
            },
            response: {
              headers: [{ name: 'Set-Cookie', value: 'sid=secretvalue; Path=/' }],
              cookies: [{ name: 'sid', value: 'secretvalue' }],
              content: { mimeType: 'text/html', text: '<html>personal</html>' },
            },
          },
        ],
      },
    };
    const sanitized = JSON.stringify(sanitizeHarObject(har));
    expect(sanitized).not.toContain('secretvalue');
    expect(sanitized).not.toContain('Bearer xyz');
    expect(sanitized).not.toContain('identifier1234567');
    expect(sanitized).not.toContain('name=child');
    expect(sanitized).not.toContain('<html>personal</html>');
    expect(sanitized).toContain('tracker.example/collect');
    expect(sanitized).toContain('"name":"uid"');
  });
});

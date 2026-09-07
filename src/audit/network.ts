import type { BrowserContext, CDPSession, Page, Frame } from 'playwright';
import type { RequestRecord, CookieSetAttempt, FrameRecord, RunPhase } from '../types.js';
import { sanitizeUrl } from '../util/sanitize.js';
import { sha256 } from '../util/hash.js';
import { domainInfo, isThirdParty, cookieDomainToRegistrable } from '../util/domains.js';

/**
 * Network evidence capture.
 *
 * Playwright's own request/response events do not expose *blocked* cookies or
 * the browser's reason for blocking them, so the capture is driven by the
 * Chrome DevTools Protocol directly (Network domain, including the
 * "ExtraInfo" events that carry cookie handling details).
 */
export class NetworkRecorder {
  readonly requests: RequestRecord[] = [];
  readonly cookieAttempts: CookieSetAttempt[] = [];
  readonly frames: FrameRecord[] = [];
  readonly consoleErrors: string[] = [];

  private byRequestId = new Map<string, RequestRecord>();
  private pendingExtra = new Map<string, { setCookieHeaders: string[]; blocked: any[] }>();
  private sessions: CDPSession[] = [];
  private seenFrameUrls = new Set<string>();

  constructor(
    private readonly firstPartyDomain: string,
    private readonly t0: () => number,
    private readonly phase: () => RunPhase,
    private readonly consentActionDone: () => boolean,
  ) {}

  private now(): number {
    return Math.round(performance.now() - this.t0());
  }

  async attachToContext(context: BrowserContext): Promise<void> {
    for (const page of context.pages()) await this.attachToPage(page);
    context.on('page', (page) => {
      void this.attachToPage(page).catch(() => undefined);
    });
  }

  async attachToPage(page: Page): Promise<void> {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text().slice(0, 500);
        if (this.consoleErrors.length < 200) this.consoleErrors.push(text);
      }
    });
    page.on('frameattached', (frame) => this.recordFrame(frame));
    page.on('framenavigated', (frame) => this.recordFrame(frame));

    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(page);
    } catch {
      return; // non-Chromium engine: fall back to Playwright events only
    }
    this.sessions.push(session);
    await session.send('Network.enable', {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 5_000_000,
    }).catch(() => undefined);
    await session.send('Page.enable').catch(() => undefined);

    session.on('Network.requestWillBeSent', (event: any) => this.onRequest(event));
    session.on('Network.requestWillBeSentExtraInfo', (event: any) => this.onRequestExtraInfo(event));
    session.on('Network.responseReceived', (event: any) => this.onResponse(event));
    session.on('Network.responseReceivedExtraInfo', (event: any) => this.onResponseExtraInfo(event));
    session.on('Network.loadingFailed', (event: any) => this.onLoadingFailed(event));
  }

  private recordFrame(frame: Frame): void {
    const url = frame.url();
    if (!url || url === 'about:blank') return;
    const key = `${frame.name()}|${url}`;
    if (this.seenFrameUrls.has(key)) return;
    this.seenFrameUrls.add(key);
    const info = domainInfo(url);
    this.frames.push({
      frameUrl: sanitizeUrl(url),
      frameDomain: info.hostname,
      registrableDomain: info.registrableDomain,
      isThirdParty: isThirdParty(url, this.firstPartyDomain),
      name: frame.name() || null,
      firstSeenTRelMs: this.now(),
      phase: this.phase(),
    });
  }

  /** Iframes created by ad scripts often never fire Playwright frame events. */
  noteFrameUrls(urls: Array<{ url: string; name?: string | null }>): void {
    for (const entry of urls) {
      const url = entry.url;
      if (!url || url === 'about:blank') continue;
      const key = `${entry.name ?? ''}|${url}`;
      if (this.seenFrameUrls.has(key)) continue;
      this.seenFrameUrls.add(key);
      const info = domainInfo(url);
      this.frames.push({
        frameUrl: sanitizeUrl(url),
        frameDomain: info.hostname,
        registrableDomain: info.registrableDomain,
        isThirdParty: isThirdParty(url, this.firstPartyDomain),
        name: entry.name ?? null,
        firstSeenTRelMs: this.now(),
        phase: this.phase(),
      });
    }
  }

  private onRequest(event: any): void {
    const url: string = event.request?.url ?? '';
    if (!url) return;
    // A redirect reuses the request id: close off the previous hop before the
    // new one replaces it in the lookup table, otherwise redirect hops end up
    // recorded without a status.
    const previousHop = this.byRequestId.get(event.requestId);
    if (event.redirectResponse && previousHop) {
      previousHop.status = event.redirectResponse.status ?? null;
      previousHop.responseMimeType = event.redirectResponse.mimeType ?? previousHop.responseMimeType;
    }
    const info = domainInfo(url);
    const record: RequestRecord = {
      id: event.requestId,
      tRelMs: this.now(),
      wallClock: new Date().toISOString(),
      url: sanitizeUrl(url),
      urlSha256: sha256(url),
      hostname: info.hostname ?? '',
      registrableDomain: info.registrableDomain,
      isThirdParty: isThirdParty(url, this.firstPartyDomain),
      method: event.request?.method ?? 'GET',
      resourceType: event.type ?? null,
      frameUrl: event.documentURL ? sanitizeUrl(event.documentURL) : null,
      initiatorType: event.initiator?.type ?? null,
      initiatorUrl: event.initiator?.url ? sanitizeUrl(event.initiator.url) : null,
      status: null,
      responseMimeType: null,
      phase: this.phase(),
      beforeConsentAction: !this.consentActionDone(),
      setCookieCount: 0,
      failure: null,
    };
    this.requests.push(record);
    this.byRequestId.set(event.requestId, record);
  }

  /**
   * Reasons that mean "this cookie simply did not apply to this request"
   * (wrong domain, wrong path, http vs https) rather than "the browser refused
   * to send a cookie that otherwise applied". Only the latter is interesting as
   * evidence, so the former is recorded but not counted as blocked.
   */
  private static SCOPE_REASONS = new Set([
    'DomainMismatch',
    'NotOnPath',
    'SecureOnly',
    'SchemeMismatch',
    'PortMismatch',
    'NameValuePairExceedsMaxSize',
  ]);

  private onRequestExtraInfo(event: any): void {
    const record = this.byRequestId.get(event.requestId);
    const associated: any[] = event.associatedCookies ?? [];
    for (const item of associated) {
      const cookie = item.cookie ?? {};
      const blockedReasons: string[] = item.blockedReasons ?? [];
      const policyBlocked = blockedReasons.some((reason) => !NetworkRecorder.SCOPE_REASONS.has(reason));
      const exemption = item.exemptionReason && item.exemptionReason !== 'None' ? [`exempted:${item.exemptionReason}`] : [];
      this.cookieAttempts.push({
        tRelMs: this.now(),
        source: 'request',
        name: cookie.name ?? '',
        domain: cookie.domain ?? null,
        registrableDomain: cookie.domain ? cookieDomainToRegistrable(cookie.domain) : null,
        path: cookie.path ?? null,
        valueLength: (cookie.value ?? '').length,
        valueSha256: sha256(cookie.value ?? ''),
        blocked: policyBlocked,
        blockedReasons: [...blockedReasons, ...exemption],
        requestUrl: record?.url ?? null,
        requestDomain: record?.registrableDomain ?? null,
        isThirdParty: record?.isThirdParty ?? null,
        phase: record?.phase ?? this.phase(),
        beforeConsentAction: record?.beforeConsentAction ?? !this.consentActionDone(),
      });
    }
  }

  private onResponse(event: any): void {
    const record = this.byRequestId.get(event.requestId);
    if (!record) return;
    record.status = event.response?.status ?? null;
    record.responseMimeType = event.response?.mimeType ?? null;
    if (!record.resourceType && event.type) record.resourceType = event.type;
  }

  private onResponseExtraInfo(event: any): void {
    const record = this.byRequestId.get(event.requestId);
    const headers: Record<string, string> = event.headers ?? {};
    const setCookieHeader =
      headers['set-cookie'] ?? headers['Set-Cookie'] ?? (event.cookiePartitionKey ? '' : '');
    const lines = setCookieHeader ? setCookieHeader.split('\n').filter(Boolean) : [];
    const blocked: any[] = event.blockedCookies ?? [];
    const exempted: any[] = event.exemptedCookies ?? [];

    if (record) record.setCookieCount += lines.length;

    const blockedByLine = new Map<string, string[]>();
    for (const item of blocked) {
      const line = item.cookieLine ?? '';
      const reasons: string[] = item.blockedReasons ?? [];
      blockedByLine.set(line, reasons);
      const cookie = item.cookie ?? parseCookieLine(line);
      this.cookieAttempts.push(this.buildAttempt(record, cookie, reasons, true));
    }
    for (const item of exempted) {
      const cookie = item.cookie ?? parseCookieLine(item.cookieLine ?? '');
      this.cookieAttempts.push(
        this.buildAttempt(record, cookie, [`exempted:${item.exemptionReason ?? 'unknown'}`], false),
      );
    }
    for (const line of lines) {
      if (blockedByLine.has(line)) continue;
      const cookie = parseCookieLine(line);
      if (!cookie.name) continue;
      this.cookieAttempts.push(this.buildAttempt(record, cookie, [], false));
    }
  }

  private buildAttempt(
    record: RequestRecord | undefined,
    cookie: any,
    reasons: string[],
    blocked: boolean,
  ): CookieSetAttempt {
    const domain = cookie.domain ?? (record ? record.hostname : null);
    return {
      tRelMs: this.now(),
      source: 'response',
      name: cookie.name ?? '',
      domain,
      registrableDomain: domain ? cookieDomainToRegistrable(domain) : null,
      path: cookie.path ?? null,
      valueLength: (cookie.value ?? '').length,
      valueSha256: sha256(cookie.value ?? ''),
      blocked,
      blockedReasons: reasons,
      requestUrl: record?.url ?? null,
      requestDomain: record?.registrableDomain ?? null,
      isThirdParty: record?.isThirdParty ?? null,
      phase: record?.phase ?? this.phase(),
      beforeConsentAction: record?.beforeConsentAction ?? !this.consentActionDone(),
    };
  }

  private onLoadingFailed(event: any): void {
    const record = this.byRequestId.get(event.requestId);
    if (!record) return;
    record.failure = event.errorText ?? 'failed';
  }

  async detach(): Promise<void> {
    for (const session of this.sessions) {
      await session.detach().catch(() => undefined);
    }
    this.sessions.length = 0;
  }
}

export function parseCookieLine(line: string): { name: string; value: string; domain: string | null; path: string | null } {
  const parts = line.split(';');
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  const name = eq >= 0 ? nameValue.slice(0, eq).trim() : nameValue.trim();
  const value = eq >= 0 ? nameValue.slice(eq + 1).trim() : '';
  let domain: string | null = null;
  let path: string | null = null;
  for (const attr of attrs) {
    const [key, val] = attr.split('=');
    const k = (key ?? '').trim().toLowerCase();
    if (k === 'domain') domain = (val ?? '').trim() || null;
    if (k === 'path') path = (val ?? '').trim() || null;
  }
  return { name, value, domain, path };
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Tiny synthetic website used to test the audit engine without touching the
 * live educational sites. One HTTP server answers for three hostnames:
 *
 *   first-party.test        the "educational site" with a consent banner
 *   tracker.third-party.test a simulated tracker (sets cookies, beacons)
 *   ads.adnetwork.test      a simulated ad frame
 *
 * Chromium is launched with --host-resolver-rules so all three resolve to this
 * server. Behaviour differs per consent decision, which is what the engine
 * tests assert on.
 */

export interface FixtureServer {
  port: number;
  baseUrl: string;
  hostResolverRule: string;
  requests: Array<{ host: string; url: string; cookies: string | undefined }>;
  close(): Promise<void>;
}

const PAGE_HEAD = `
<meta charset="utf-8">
<title>Oefenfixture</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  header { background: #cfe8cf; padding: 12px; }
  main { padding: 16px; }
  .ad-slot { border: 1px dashed #999; margin: 12px 0; }
  #consent-banner { position: fixed; inset: auto 0 0 0; background: #222; color: #fff; padding: 16px; }
  #consent-banner button { padding: 8px 14px; margin-right: 8px; }
</style>`;

function consentBanner(): string {
  return `
<div id="consent-banner" role="dialog" aria-label="Cookietoestemming">
  <p>Wij gebruiken cookies en vergelijkbare technieken.</p>
  <button id="accept-all" type="button">Alles accepteren</button>
  <button id="reject-all" type="button">Alles weigeren</button>
</div>
<script>
  window.__fixtureConsentState = { decision: null };
  function decide(decision) {
    window.__fixtureConsentState = { decision: decision };
    document.cookie = 'fixture_consent=' + decision + '; path=/; max-age=3600';
    document.getElementById('consent-banner').style.display = 'none';
    if (decision === 'accept') {
      const s = document.createElement('script');
      s.src = 'http://tracker.third-party.test/track.js?after=consent';
      document.body.appendChild(s);
      const px = new Image();
      px.src = 'http://tracker.third-party.test/pixel.gif?event=accept';
      const frame = document.createElement('iframe');
      frame.src = 'http://ads.adnetwork.test/ad.html?slot=extra';
      frame.width = 300; frame.height = 250;
      frame.className = 'ad-slot';
      document.getElementById('slots').appendChild(frame);
    }
    try { localStorage.setItem('fixture_decision', decision); } catch (e) {}
  }
  document.getElementById('accept-all').addEventListener('click', () => decide('accept'));
  document.getElementById('reject-all').addEventListener('click', () => decide('reject'));
</script>`;
}

function homePage(): string {
  return `<!doctype html><html lang="nl"><head>${PAGE_HEAD}</head><body>
<header><h1>Oefenfixture</h1></header>
<main>
  <p>Een nagebootste oefensite voor het testen van de auditsoftware.</p>
  <a href="/exercise">Start de oefening</a>
  <div id="slots">
    <iframe class="ad-slot" src="http://ads.adnetwork.test/ad.html?slot=leaderboard" width="728" height="90"></iframe>
  </div>
</main>
<script src="http://tracker.third-party.test/track.js?stage=preconsent"></script>
<img src="http://tracker.third-party.test/redirect-pixel" alt="" width="1" height="1">
<script>
  // A delayed third-party request that fires regardless of the consent choice.
  setTimeout(function () {
    var img = new Image();
    img.src = 'http://tracker.third-party.test/pixel.gif?event=delayed';
  }, 2000);
  try { localStorage.setItem('fixture_visit', String(Date.now())); } catch (e) {}
</script>
${consentBanner()}
</body></html>`;
}

function exercisePage(): string {
  return `<!doctype html><html lang="nl"><head>${PAGE_HEAD}</head><body>
<header><h1>Oefening</h1></header>
<main id="exercise">
  <p>Hoeveel is 3 + 4?</p>
  <div id="slots">
    <iframe class="ad-slot" src="http://ads.adnetwork.test/ad.html?slot=exercise" width="336" height="280"></iframe>
  </div>
</main>
<script src="http://tracker.third-party.test/track.js?stage=exercise"></script>
</body></html>`;
}

function adPage(slot: string): string {
  const color = slot === 'leaderboard' ? '#ffd9a0' : '#a0d9ff';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:${color};font-family:sans-serif}</style></head>
<body><strong>Advertentie (${slot})</strong></body></html>`;
}

export async function startFixtureServer(preferredPort = 0): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = req.url ?? '/';
    requests.push({ host, url, cookies: req.headers.cookie });

    if (host === 'tracker.third-party.test') {
      // A third-party cookie without SameSite=None: Chromium blocks it, which
      // is exactly the "attempted but blocked" evidence the audit must capture.
      res.setHeader('Set-Cookie', [
        'tracker_id=abc123456789; Path=/; Max-Age=3600',
        'tracker_sn=xyz987654321; Path=/; Max-Age=3600; SameSite=None',
      ]);
      if (url.startsWith('/redirect-pixel')) {
        // Exercises the recorder's redirect bookkeeping.
        res.writeHead(302, { Location: 'http://tracker.third-party.test/pixel.gif?event=redirected' });
        res.end();
        return;
      }
      if (url.startsWith('/pixel.gif')) {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__fixtureTrackerLoaded = true;');
      return;
    }

    if (host === 'ads.adnetwork.test') {
      const slot = new URL(url, 'http://ads.adnetwork.test').searchParams.get('slot') ?? 'unknown';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(adPage(slot));
      return;
    }

    // first-party.test
    res.setHeader('Set-Cookie', 'fixture_session=s-0123456789abcdef; Path=/; Max-Age=3600; SameSite=Lax');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(url.startsWith('/exercise') ? exercisePage() : homePage());
  });

  await new Promise<void>((resolve) => server.listen(preferredPort, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: 'http://first-party.test',
    hostResolverRule: `--host-resolver-rules=MAP *.test 127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Allow running the fixture standalone for manual inspection.
if (process.argv[1] && process.argv[1].endsWith('fixtures/site/server.ts')) {
  const port = Number(process.env.FIXTURE_PORT ?? 8099);
  startFixtureServer(port).then((server) => {
    console.log(`Fixture site listening on 127.0.0.1:${server.port}`);
    console.log(`Launch a browser with: ${server.hostResolverRule}`);
  });
}

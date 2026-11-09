#!/usr/bin/env node
// AFMGUI server — zero dependencies.
//
// * Serves the web app in ./public
// * Forwards /health and /v1/* to Apple's `fm serve` (http://127.0.0.1:1976),
//   dropping the browser's Origin / Referer / Sec-Fetch-* headers, so the
//   browser only ever talks to one same-origin address.
// * Listens on 0.0.0.0 so other devices on your network can use it.
// * Also serves HTTPS (self-signed, local CA) because Safari dictation on
//   iPhone/iPad needs a secure context.
// * Starts plain `fm serve` for you if it isn't already running.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, '.certs');

const args = new Set(process.argv.slice(2));
const env = process.env;

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node server.mjs [--no-fm] [--no-https]

Environment variables:
  PORT           HTTP port (default 1977)
  HTTPS_PORT     HTTPS port (default PORT + 1)
  HOST           Bind address (default 0.0.0.0, i.e. reachable on your network)
  FM_URL         Where fm serve listens (default http://127.0.0.1:1976)
  ALLOWED_HOSTS  Extra host names allowed to reach the app, comma separated
  SPAWN_FM=0     Don't start fm serve automatically (same as --no-fm)
  HTTPS=0        Don't serve HTTPS (same as --no-https)`);
  process.exit(0);
}

const HOST = env.HOST || '0.0.0.0';
const PORT = toPort(env.PORT, 1977);
const HTTPS_PORT = toPort(env.HTTPS_PORT, PORT + 1);
const FM_URL = new URL(env.FM_URL || 'http://127.0.0.1:1976');
const ENABLE_HTTPS = !(args.has('--no-https') || env.HTTPS === '0');
const SPAWN_FM = !(args.has('--no-fm') || env.SPAWN_FM === '0');
const EXTRA_HOSTS = (env.ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const LOCAL_HOSTNAME = getLocalHostName(); // e.g. "Omers-MacBook-Pro"
const MDNS_NAME = LOCAL_HOSTNAME ? `${LOCAL_HOSTNAME.toLowerCase()}.local` : null;
const ALLOWED_NAMES = new Set(
  [os.hostname(), MDNS_NAME, LOCAL_HOSTNAME, ...EXTRA_HOSTS]
    .filter(Boolean)
    .map((h) => h.toLowerCase().replace(/\.$/, '')),
);

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m` }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s, red: (s) => s };

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
].join('; ');

// Headers that must not be forwarded to fm serve. Dropping Origin and the
// Sec-Fetch-* family is what lets the browser talk to fm serve through us.
const DROP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'connection', 'keep-alive',
  'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'expect',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'access-control-allow-origin',
  'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'vary',
]);

let certInfo = null; // { caDer } once HTTPS is set up

function handler(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://placeholder');
  } catch {
    return sendJSON(res, 400, apiError(400, 'Bad request URL.', 'invalid_request_error'));
  }

  // DNS-rebinding protection: only answer to names that really are this Mac.
  if (!hostAllowed(req.headers.host)) {
    return sendText(
      res,
      403,
      `Host "${req.headers.host}" is not allowed. Open the app via localhost, this Mac's IP address or ${MDNS_NAME || 'its .local name'}, or start the server with ALLOWED_HOSTS=${String(req.headers.host).replace(/:\d+$/, '')}.`,
    );
  }

  const p = url.pathname;
  if (p === '/health' || p.startsWith('/v1/')) {
    // Keep fm serve's cross-site protection: only the app itself (same origin)
    // or non-browser clients may use the forwarded API.
    if (isCrossSite(req)) {
      return sendJSON(res, 403, apiError(403, 'Cross-site requests are not allowed.', 'permission_denied'));
    }
    return proxy(req, res);
  }
  if (p === '/_app/info') return sendJSON(res, 200, appInfo(req));
  if (p === '/_app/lookup') {
    if (isCrossSite(req)) {
      return sendJSON(res, 403, apiError(403, 'Cross-site requests are not allowed.', 'permission_denied'));
    }
    return lookup(req, res);
  }
  if (p === '/ca.crt') return serveCA(req, res);
  return serveStatic(req, res, p);
}

function proxy(req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(name) || name.startsWith('sec-fetch-') || name.startsWith('sec-ch-')) continue;
    headers[name] = value;
  }
  headers.host = FM_URL.host;

  const upstream = http.request(
    {
      protocol: FM_URL.protocol,
      hostname: FM_URL.hostname,
      port: FM_URL.port || 80,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const out = { ...SECURITY_HEADERS };
      for (const [name, value] of Object.entries(up.headers)) {
        if (!DROP_RESPONSE_HEADERS.has(name)) out[name] = value;
      }
      if (String(up.headers['content-type'] || '').includes('text/event-stream')) {
        out['cache-control'] = 'no-cache, no-transform';
        out['x-accel-buffering'] = 'no';
      }
      res.writeHead(up.statusCode || 502, out);
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      up.pipe(res);
      up.on('error', () => res.destroy());
    },
  );

  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    const unreachable = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOENT', 'ETIMEDOUT'].includes(err.code);
    sendJSON(
      res,
      502,
      apiError(
        502,
        unreachable
          ? `Can't reach fm serve at ${FM_URL.origin}. Start it on your Mac with \`fm serve\`.`
          : `fm serve request failed: ${err.message}`,
        'fm_unreachable',
      ),
    );
  });

  // If the browser goes away (e.g. the user pressed Stop), stop generating.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed');
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes('\0')) {
    return sendText(res, 404, 'Not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function serveCA(req, res) {
  if (!certInfo?.caDer) return sendText(res, 404, 'HTTPS is turned off, so there is no certificate to install.');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="AFMGUI-Local-CA.crt"',
    'Content-Length': certInfo.caDer.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : certInfo.caDer);
}

// --- Web lookup -------------------------------------------------------------
// Optional and off by default in the app. Searches Wikipedia for a short query
// and returns the opening paragraphs of the best matches, so the small
// on-device model can answer from real text instead of guessing.

const LOOKUP_LIMIT = 3;
const LOOKUP_CHARS = 900;

async function lookup(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, apiError(405, 'Use POST.', 'invalid_request_error'));
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, 4096));
  } catch {
    return sendJSON(res, 400, apiError(400, 'Bad lookup request.', 'invalid_request_error'));
  }
  const q = String(body?.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return sendJSON(res, 200, { query: q, results: [] });
  const lang = /^[a-z]{2,3}$/.test(body?.lang) ? body.lang : 'en';
  try {
    let results = await searchWikipedia(q, lang);
    if (!results.length && lang !== 'en') results = await searchWikipedia(q, 'en');
    return sendJSON(res, 200, { query: q, source: 'Wikipedia', results });
  } catch {
    return sendJSON(res, 502, apiError(502, 'Wikipedia could not be reached.', 'lookup_failed'));
  }
}

async function searchWikipedia(q, lang) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: String(LOOKUP_LIMIT),
    prop: 'extracts|info',
    exintro: '1',
    explaintext: '1',
    exlimit: String(LOOKUP_LIMIT),
    inprop: 'url',
    redirects: '1',
  }).toString();
  const r = await fetch(url, {
    headers: { 'User-Agent': 'AFMGUI/1.0 (local chat app for Apple Foundation Models)', Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Wikipedia answered ${r.status}`);
  const data = await r.json();
  return Object.values(data?.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((pg) => ({
      title: String(pg.title ?? ''),
      url: String(pg.fullurl ?? ''),
      text: clip(String(pg.extract ?? '').replace(/\s+/g, ' ').trim(), LOOKUP_CHARS),
    }))
    .filter((x) => x.title && x.text && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(x.url));
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function appInfo(req) {
  const ips = lanIPv4s();
  return {
    httpPort: PORT,
    httpsPort: certInfo ? HTTPS_PORT : null,
    hostname: MDNS_NAME,
    lanAddresses: ips,
    secure: Boolean(req.socket.encrypted),
  };
}

function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return true; // non-browser clients
  let h = String(hostHeader).toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  else h = h.replace(/:\d+$/, '');
  h = h.replace(/\.$/, '');
  if (net.isIP(h)) return true; // IP literals can't be DNS-rebound
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return ALLOWED_NAMES.has(h);
}

function apiError(code, message, type) {
  return { error: { code: String(code), message, type } };
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// fm serve
// ---------------------------------------------------------------------------

let fmChild = null;
let shuttingDown = false;

function fmHealthy(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(new URL('/health', FM_URL), { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function ensureFm() {
  if (await fmHealthy()) return 'running';
  const isLocal = ['127.0.0.1', 'localhost'].includes(FM_URL.hostname) && FM_URL.protocol === 'http:';
  if (!SPAWN_FM || !isLocal) return 'missing';

  // Plain `fm serve` (port 1976) unless FM_URL points somewhere else locally.
  const fmPort = FM_URL.port || '80';
  const fmArgs = fmPort === '1976' ? ['serve'] : ['serve', '--port', fmPort];
  const bin = fs.existsSync('/usr/bin/fm') ? '/usr/bin/fm' : 'fm';
  try {
    fmChild = spawn(bin, fmArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.log(c.yellow(`  Couldn't start fm serve: ${err.message}`));
    return 'missing';
  }
  const prefix = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line) console.log(c.dim(`  [fm] ${line}`));
      }
    });
  };
  prefix(fmChild.stdout);
  prefix(fmChild.stderr);
  fmChild.on('error', (err) => {
    console.log(c.yellow(`  Couldn't start fm serve (${err.message}). Start it yourself with: fm serve`));
    fmChild = null;
  });
  fmChild.on('exit', (code, signal) => {
    fmChild = null;
    if (!shuttingDown) console.log(c.yellow(`  fm serve stopped (${signal || `exit ${code}`}). Start it again with: fm serve`));
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!fmChild) return 'missing';
    if (await fmHealthy(1000)) return 'started';
  }
  return 'starting';
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (fmChild) fmChild.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => fmChild?.kill('SIGTERM'));

// ---------------------------------------------------------------------------
// HTTPS certificates (local CA, created once, constrained to local names)
// ---------------------------------------------------------------------------

function ensureCerts() {
  const f = (name) => path.join(CERT_DIR, name);
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(f('ca.key')) || !fs.existsSync(f('ca.crt'))) {
    // Name constraints: even if someone got hold of this CA's key, it could
    // only vouch for localhost, *.local and private-network IP addresses.
    fs.writeFileSync(
      f('ca.cnf'),
      `[req]
distinguished_name = dn
prompt = no
[dn]
O = AFMGUI
CN = AFMGUI Local CA (${(LOCAL_HOSTNAME || os.hostname()).replace(/[^\w .-]/g, '')})
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:localhost, permitted;DNS:local, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:169.254.0.0/255.255.0.0, permitted;IP:100.64.0.0/255.192.0.0
`,
    );
    openssl(['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', f('ca.key'), '-out', f('ca.crt'), '-config', f('ca.cnf'), '-extensions', 'v3_ca']);
    fs.chmodSync(f('ca.key'), 0o600);
    fs.rmSync(f('server.json'), { force: true });
  }

  const sans = ['DNS:localhost', ...(MDNS_NAME ? [`DNS:${MDNS_NAME}`] : []), 'IP:127.0.0.1',
    ...lanIPv4s().filter(isPrivateIPv4).map((ip) => `IP:${ip}`)];
  const wanted = JSON.stringify(sans);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(f('server.json'), 'utf8'));
  } catch {}
  const fresh = meta && meta.sans === wanted && meta.notAfter > Date.now() + 30 * 86400e3
    && fs.existsSync(f('server.key')) && fs.existsSync(f('server.crt'));

  if (!fresh) {
    fs.writeFileSync(
      f('server.ext'),
      `[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = ${sans.join(', ')}
`,
    );
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/O=AFMGUI/CN=AFMGUI local server',
      '-keyout', f('server.key'), '-out', f('server.csr')]);
    openssl(['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'),
      '-set_serial', `0x${crypto.randomBytes(12).toString('hex')}`, '-days', '397', '-sha256',
      '-extfile', f('server.ext'), '-extensions', 'v3_leaf', '-out', f('server.crt')]);
    fs.chmodSync(f('server.key'), 0o600);
    fs.rmSync(f('server.csr'), { force: true });
    fs.writeFileSync(f('server.json'), JSON.stringify({ sans: wanted, notAfter: Date.now() + 397 * 86400e3 }));
  }

  if (!fs.existsSync(f('ca.der'))) openssl(['x509', '-in', f('ca.crt'), '-outform', 'der', '-out', f('ca.der')]);

  return {
    key: fs.readFileSync(f('server.key')),
    cert: Buffer.concat([fs.readFileSync(f('server.crt')), fs.readFileSync(f('ca.crt'))]),
    caDer: fs.readFileSync(f('ca.der')),
  };
}

function openssl(argv) {
  execFileSync('openssl', argv, { stdio: ['ignore', 'ignore', 'pipe'] });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function getLocalHostName() {
  try {
    return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return os.hostname().replace(/\.local$/i, '');
  }
}

function lanIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} (${label}) is already in use. Stop the other process or pick another port, e.g. PORT=${PORT + 10} npm start`));
      } else reject(err);
    });
    server.listen(port, HOST, resolve);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const httpServer = http.createServer(handler);
  httpServer.requestTimeout = 0; // replies can stream for a while
  await listen(httpServer, PORT, 'HTTP');

  let httpsServer = null;
  if (ENABLE_HTTPS) {
    try {
      certInfo = ensureCerts();
      httpsServer = https.createServer({ key: certInfo.key, cert: certInfo.cert }, handler);
      httpsServer.requestTimeout = 0;
      await listen(httpsServer, HTTPS_PORT, 'HTTPS');
    } catch (err) {
      certInfo = null;
      httpsServer = null;
      console.log(c.yellow(`  HTTPS is off: ${String(err.stderr || err.message).trim()}`));
    }
  }

  const fmState = await ensureFm();

  const lan = HOST === '0.0.0.0' || HOST === '::' ? lanIPv4s() : [];
  const row = (label, value) => console.log(`  ${c.dim(label.padEnd(12))}${value}`);
  console.log(`\n  ${c.bold('AFMGUI is running')}\n`);
  row('This Mac', c.cyan(`http://localhost:${PORT}`));
  for (const ip of lan) row('Network', c.cyan(`http://${ip}:${PORT}`));
  if (httpsServer) {
    for (const ip of lan) row('HTTPS', `${c.cyan(`https://${ip}:${HTTPS_PORT}`)}  ${c.dim('for dictation on iPhone/iPad')}`);
    if (lan.length) row('', c.dim(`One-time setup: open http://${lan[0]}:${PORT}/ca.crt on the device and trust it.`));
  }
  console.log();
  if (fmState === 'running') row('fm serve', c.green(`running at ${FM_URL.origin}`));
  else if (fmState === 'started') row('fm serve', c.green(`started at ${FM_URL.origin}`));
  else if (fmState === 'starting') row('fm serve', c.yellow('starting…'));
  else row('fm serve', c.red(`not running. Start it with: fm serve`));
  console.log(`\n  ${c.dim('Press Ctrl+C to stop.')}\n`);
}

main().catch((err) => {
  console.error(c.red(`\n  ${err.message}\n`));
  shutdown();
  process.exitCode = 1;
});

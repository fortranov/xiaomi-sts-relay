import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export function validateStsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'sts.api.io.mi.com' &&
      url.port === '' &&
      url.pathname === '/sts' &&
      url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export function parseCookies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('cookies must be an object');
  }
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 64) throw new TypeError('too many cookies');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || typeof item !== 'string' || item.length > 4096) {
      throw new TypeError('invalid cookie');
    }
    result[key] = item;
  }
  return result;
}

export class RateLimiter {
  constructor(limit, windowMs, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.entries = new Map();
  }

  allow(key) {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || now - entry.start > this.windowMs) entry = {start: now, count: 0};
    entry.count += 1;
    this.entries.set(key, entry);
    return entry.count <= this.limit;
  }
}

export function secureTokenEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jsonResponse(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
  });
  response.end(data);
}

async function readJson(request, maxBytes = 65536) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new RangeError('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function exchangeWithXiaomi({url, cookies, userAgent = 'Mozilla/5.0'}) {
  let current = new URL(url);
  const jar = {...cookies};
  let status = 0;
  for (let hop = 0; hop < 5; hop += 1) {
    const cookieHeader = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');
    const result = await new Promise((resolve, reject) => {
      const upstream = https.request(current, {
        method: 'GET',
        headers: {'user-agent': userAgent.slice(0, 512), cookie: cookieHeader, connection: 'close'},
      }, upstreamResponse => {
        const raw = upstreamResponse.headers['set-cookie'];
        const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const resolved = {
          status: upstreamResponse.statusCode || 0,
          location: upstreamResponse.headers.location,
          setCookies,
        };
        upstreamResponse.destroy();
        resolve(resolved);
      });
      upstream.setTimeout(8000, () => upstream.destroy(new Error('Xiaomi STS header timeout')));
      upstream.on('error', reject);
      upstream.end();
    });
    status = result.status;
    for (const raw of result.setCookies) {
      const first = raw.split(';', 1)[0];
      const position = first.indexOf('=');
      if (position > 0) jar[first.slice(0, position).trim()] = first.slice(position + 1).trim();
    }
    const serviceToken = jar.serviceToken || jar.yetAnotherServiceToken;
    if (serviceToken) return {status, serviceToken};
    if (status >= 300 && status < 400 && result.location) {
      const next = new URL(result.location, current);
      if (!validateStsUrl(next.toString())) throw new Error('STS redirect is not allowed');
      current = next;
      continue;
    }
    break;
  }
  return {status, serviceToken: null};
}

export function createRelayServer({clientKey, exchange = exchangeWithXiaomi}) {
  if (!clientKey) throw new Error('RELAY_CLIENT_KEY is required');
  const perIp = new RateLimiter(10, 60_000);
  const global = new RateLimiter(200, 3_600_000);
  const cache = new Map();

  return http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    if (request.method === 'GET' && request.url === '/health') {
      return jsonResponse(response, 200, {ok: true});
    }
    if (request.method !== 'POST' || request.url !== '/v1/sts') {
      return jsonResponse(response, 404, {error: 'not found'});
    }
    if (!secureTokenEqual(clientKey, request.headers['x-relay-key'])) {
      return jsonResponse(response, 401, {error: 'unauthorized'});
    }
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || request.socket.remoteAddress || 'unknown';
    if (!perIp.allow(ip) || !global.allow('global')) {
      return jsonResponse(response, 429, {error: 'rate limit exceeded'});
    }
    try {
      const body = await readJson(request);
      if (!validateStsUrl(body?.url)) return jsonResponse(response, 400, {error: 'invalid STS URL'});
      const cookies = parseCookies(body.cookies || {});
      const digest = crypto.createHash('sha256').update(body.url).digest('hex');
      const cached = cache.get(digest);
      let result;
      if (cached && cached.expires > Date.now()) result = cached.result;
      else {
        result = await exchange({url: body.url, cookies, userAgent: String(body.userAgent || 'Mozilla/5.0')});
        if (result.serviceToken) cache.set(digest, {expires: Date.now() + 600_000, result});
      }
      const headers = {
        'content-length': '0',
        'cache-control': 'no-store',
        'x-xiaomi-sts-status': String(result.status || 0),
        'x-xiaomi-sts-success': result.status === 200 && result.serviceToken ? '1' : '0',
      };
      if (result.serviceToken) headers['x-xiaomi-service-token-b64'] = Buffer.from(result.serviceToken).toString('base64');
      response.writeHead(200, headers);
      response.end();
    } catch (error) {
      const status = error instanceof RangeError ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 502;
      jsonResponse(response, status, {error: status === 502 ? 'upstream exchange failed' : error.message});
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStsUrl, parseCookies, RateLimiter, secureTokenEqual, createRelayServer } from '../relay.mjs';

test('accepts only the exact Xiaomi HTTPS STS endpoint', () => {
  assert.equal(validateStsUrl('https://sts.api.io.mi.com/sts?_nonce=x'), true);
  for (const url of [
    'http://sts.api.io.mi.com/sts',
    'https://evil.example/sts',
    'https://sts.api.io.mi.com/other',
    'https://sts.api.io.mi.com.evil.example/sts',
    'not-a-url',
  ]) assert.equal(validateStsUrl(url), false, url);
});

test('cookie parser accepts a bounded plain object only', () => {
  assert.deepEqual(parseCookies({a: '1', b: 'two'}), {a: '1', b: 'two'});
  assert.throws(() => parseCookies([]));
  assert.throws(() => parseCookies({a: {nested: true}}));
  assert.throws(() => parseCookies({['x'.repeat(129)]: '1'}));
  assert.throws(() => parseCookies({a: 'x'.repeat(4097)}));
});

test('rate limiter blocks excess attempts and recovers after window', () => {
  let now = 1000;
  const limiter = new RateLimiter(2, 100, () => now);
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), false);
  now += 101;
  assert.equal(limiter.allow('ip'), true);
});

test('client key comparison is exact', () => {
  assert.equal(secureTokenEqual('secret', 'secret'), true);
  assert.equal(secureTokenEqual('secret', 'Secret'), false);
  assert.equal(secureTokenEqual('', ''), false);
});

test('HTTP relay exposes health and protects the STS exchange', async (t) => {
  const exchange = async () => ({status: 200, serviceToken: 'token-value'});
  const server = createRelayServer({clientKey: 'client-secret', exchange});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const {port} = server.address();
  const base = `http://127.0.0.1:${port}`;

  let response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});

  response = await fetch(`${base}/v1/sts`, {method: 'POST', body: '{}'});
  assert.equal(response.status, 401);

  response = await fetch(`${base}/v1/sts`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-relay-key': 'client-secret'},
    body: JSON.stringify({url: 'https://evil.example/sts', cookies: {}}),
  });
  assert.equal(response.status, 400);

  response = await fetch(`${base}/v1/sts`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-relay-key': 'client-secret'},
    body: JSON.stringify({url: 'https://sts.api.io.mi.com/sts?_nonce=x', cookies: {}}),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-xiaomi-sts-success'), '1');
  assert.equal(Buffer.from(response.headers.get('x-xiaomi-service-token-b64'), 'base64').toString(), 'token-value');
  assert.equal(await response.text(), '');
});

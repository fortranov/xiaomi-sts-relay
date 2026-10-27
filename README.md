# Xiaomi STS Relay

A narrow, authenticated relay for the final Xiaomi Cloud STS exchange when an Android/Termux network cannot complete the upstream TLS request.

## Security properties

- accepts only `https://sts.api.io.mi.com/sts` URLs;
- requires `X-Relay-Key` configured through `RELAY_CLIENT_KEY`;
- applies per-IP and global rate limits;
- caps request and cookie sizes;
- never accepts or stores the Xiaomi account password;
- returns the short-lived result in response headers with an empty body;
- caches successful one-time exchanges in memory for ten minutes to make client retries idempotent;
- does not log request bodies, cookies, signed URLs, or returned tokens.

## Runtime

```bash
RELAY_CLIENT_KEY='replace-with-a-long-random-value' PORT=3000 node server.mjs
```

Health check: `GET /health`

Relay endpoint: `POST /v1/sts`

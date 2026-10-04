import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { createDb } from './db/index.js';
import { createAuth } from './lib/auth.js';
import { ApiException } from './lib/errors.js';
import { properties } from './routes/properties.js';
import { units } from './routes/units.js';
import type { AppBindings } from './types.js';

const app = new Hono<AppBindings>();

app.use('*', logger());
app.use('*', secureHeaders());

// credentials:true is required — the session is a cookie, not a bearer token — and
// that forbids a wildcard origin. WEB_ORIGIN is set per environment in wrangler.jsonc.
app.use('*', (c, next) =>
  cors({
    origin: c.env.WEB_ORIGIN,
    credentials: true,
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next),
);

// One DB client per request, shared by every handler in that request.
app.use('*', async (c, next) => {
  c.set('db', createDb(c.env.DATABASE_URL));
  await next();
});

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Better Auth owns everything under /api/auth — sign-up, sign-in, sessions, orgs.
app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

/* ---- feature routes mount here ---- */
app.route('/', properties);
app.route('/', units);

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404),
);

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return c.json(err.toBody(), err.status);
  }
  // Never leak an internal message to the client — it can carry SQL or secrets.
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'internal', message: 'Something went wrong on our end' } },
    500,
  );
});

export default app;

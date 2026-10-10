import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { createDb } from './db/index.js';
import { createAuth } from './lib/auth.js';
import { ApiException } from './lib/errors.js';
import { authLayer } from './middleware/auth-layer.js';
import { properties } from './routes/properties.js';
import { units } from './routes/units.js';
import { me } from './routes/me.js';
import { tenants } from './routes/tenants.js';
import { leases } from './routes/leases.js';
import { charges } from './routes/charges.js';
import { payments } from './routes/payments.js';
import { ledger } from './routes/ledger.js';
import { internal } from './routes/internal.js';
import { portalLeases } from './routes/portal-leases.js';
import { portalCharges } from './routes/portal-charges.js';
import { portalPayments } from './routes/portal-payments.js';
import { portal } from './routes/portal.js';
import { scheduled } from './jobs/scheduled.js';
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
  c.set('db', createDb(c.env.DATABASE_URL, c.env.NEON_LOCAL_FETCH_ENDPOINT));
  await next();
});

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Better Auth owns everything under /api/auth — sign-up, sign-in, sessions, orgs.
app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));


// Every /v1 path is classified in one table — see middleware/auth-layer.ts.
app.use('/v1/*', authLayer);

/* ---- feature routes mount here ---- */
app.route('/', properties);
app.route('/', units);
app.route('/', me);
app.route('/', tenants);
app.route('/', leases);
app.route('/', charges);
app.route('/', payments);
app.route('/', ledger);
app.route('/', internal);
// portalLeases, portalCharges and portalPayments MUST be mounted before portal:
// routes.portal.profile is `/v1/portal/:tenantId/profile`, and Hono matches in
// registration order, so `/v1/portal/leases/:id` has to be tried against these
// routers' literal paths first or it would be captured as `tenantId = "leases"`
// by `portal`'s route.
app.route('/', portalLeases);
app.route('/', portalCharges);
app.route('/', portalPayments);
app.route('/', portal);

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

export default { fetch: app.fetch, scheduled };

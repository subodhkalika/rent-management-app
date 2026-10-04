import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

/**
 * Neon's HTTP driver, not a TCP pool — Cloudflare Workers cannot hold sockets open
 * between requests. Each query is one HTTPS round trip.
 *
 * The connection is built per request (Workers forbid I/O objects at module scope),
 * which is cheap because there is no handshake to redo.
 *
 * `localFetchEndpoint` is dev-only. It should only ever be populated from the
 * `NEON_LOCAL_FETCH_ENDPOINT` Worker binding, which only exists in the Docker Compose
 * stack (see docs/TASKS/002-docker-local.md) — a deployed Worker never has it set, so
 * production always falls through to the default branch below, byte-for-byte what it
 * was before this parameter existed.
 */
export function createDb(databaseUrl: string, localFetchEndpoint?: string) {
  if (localFetchEndpoint) {
    // Dev-only override. `@neondatabase/serverless` always speaks HTTP — Workers
    // can't hold a TCP socket open between requests — and in production that HTTP
    // endpoint belongs to Neon's own edge proxy. Locally there is no Neon: Docker
    // Compose runs a stock `postgres` container, which only speaks TCP, fronted by a
    // Neon HTTP proxy sidecar. This repoints the driver's HTTP calls at that sidecar
    // instead of Neon. `fetchEndpoint` only changes *where* the HTTP request goes
    // (e.g. to a plain-HTTP proxy on the Docker network); it does not touch any
    // TLS/SSL setting, so there is nothing to weaken for production.
    neonConfig.fetchEndpoint = localFetchEndpoint;
  }
  return drizzle(neon(databaseUrl), { schema, casing: 'snake_case' });
}

export type Database = ReturnType<typeof createDb>;
export { schema };

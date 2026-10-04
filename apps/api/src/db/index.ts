import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

/**
 * Neon's HTTP driver, not a TCP pool — Cloudflare Workers cannot hold sockets open
 * between requests. Each query is one HTTPS round trip.
 *
 * The connection is built per request (Workers forbid I/O objects at module scope),
 * which is cheap because there is no handshake to redo.
 */
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema, casing: 'snake_case' });
}

export type Database = ReturnType<typeof createDb>;
export { schema };

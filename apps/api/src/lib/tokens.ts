/**
 * Invite token generation and hashing — Web Crypto only, no Node `crypto` module, so
 * this runs on Cloudflare Workers (docs/ARCHITECTURE.md §2).
 */

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, hex-encoded — matches the contract's `inviteToken` shape
 *  (`/^[0-9a-f]{64}$/`). Returned to the caller exactly once; never stored raw. */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Hex SHA-256 of `input`. The only thing ever persisted for a token. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

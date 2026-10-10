import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 60s, not vitest's default 5s.
     *
     * The integration suites talk to a real Postgres through the Neon HTTP proxy, so
     * every single query is an HTTPS round trip and a test that seeds an org, a
     * property, a unit, a tenant and a lease routinely takes 9-13 seconds. That is
     * expected, not slow-for-its-own-sake.
     *
     * This lives here rather than as a flag on one command because it was a flag on
     * one command: `test:live` passed it, CI did not, and CI therefore ran the same
     * suites with a 5s limit. It stayed green only while the tests happened to be
     * faster than that, then started failing as phase 3b's seeding grew — looking
     * like eighteen broken tests rather than one missing argument.
     *
     * Anything that genuinely hangs is caught by the job timeout, not by this.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

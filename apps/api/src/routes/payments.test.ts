import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException, conflict, notFound, validationFailed } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { PaymentRow } from '../db/repo/payment.js';

/**
 * Route-level tests for the landlord payment endpoints (PLAN-PHASE3B.md §8.1).
 * `requireAuth` is mocked to a trivial pass-through, same shape as
 * `routes/charges.test.ts` — these tests are about what the ROUTE does once a
 * landlord is already authenticated, including §9's landlord-vs-landlord half
 * of the attack table.
 */

let currentOrgId = 'org_A';
let currentUserId = 'user_1';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('orgId', currentOrgId);
    c.set('userId', currentUserId);
    await next();
  },
}));

const paymentRepoMock = {
  listPayments: vi.fn(),
  recordPayment: vi.fn(),
  updatePaymentNote: vi.fn(),
  voidPayment: vi.fn(),
  correctPayment: vi.fn(),
};
vi.mock('../db/repo/payment.js', () => paymentRepoMock);

const leaseRepoMock = { getLease: vi.fn() };
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { payments } = await import('./payments.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', payments);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const LEASE_ID = '00000000-0000-7000-8000-00000000b001';
const PAYMENT_ID = '00000000-0000-7000-8000-00000000d001';

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    leaseId: LEASE_ID,
    kind: 'payment',
    method: 'bank_transfer',
    amountCents: 100000,
    currency: 'USD',
    receivedOn: '2026-04-01',
    reference: null,
    note: null,
    supersedesPaymentId: null,
    voidedAt: null,
    voidedReason: null,
    voidedByUserId: null,
    recordedByUserId: 'user_1',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  currentOrgId = 'org_A';
  currentUserId = 'user_1';
  vi.clearAllMocks();
});

async function post(path: string, json?: unknown) {
  return buildApp().request(
    path,
    json === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function patch(path: string, json: unknown) {
  return buildApp().request(
    path,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

describe('GET /v1/leases/:id/payments', () => {
  it('404s when the lease does not exist (or is not this org\'s)', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/payments`);
    expect(res.status).toBe(404);
    expect(paymentRepoMock.listPayments).not.toHaveBeenCalled();
  });

  it('returns mapped items in order, with no nextCursor when there is no more', async () => {
    leaseRepoMock.getLease.mockResolvedValue({ id: LEASE_ID });
    paymentRepoMock.listPayments.mockResolvedValue({ rows: [paymentRow()], hasMore: false });
    const res = await get(`/v1/leases/${LEASE_ID}/payments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(PAYMENT_ID);
    expect(body.nextCursor).toBeNull();
  });

  it('400s on an invalid query param', async () => {
    const res = await get(`/v1/leases/${LEASE_ID}/payments?limit=not-a-number`);
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/leases/:id/payments', () => {
  it('creates a payment and returns 201', async () => {
    paymentRepoMock.recordPayment.mockResolvedValue(paymentRow());
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2026-04-01',
    });
    expect(res.status).toBe(201);
  });

  it('404s when the repo reports no such lease', async () => {
    paymentRepoMock.recordPayment.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2026-04-01',
    });
    expect(res.status).toBe(404);
  });

  it('409s when the repo refuses a draft/cancelled lease', async () => {
    paymentRepoMock.recordPayment.mockRejectedValue(conflict('Payments cannot be recorded against a draft or cancelled lease.'));
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2026-04-01',
    });
    expect(res.status).toBe(409);
  });

  it('409s when the repo refuses a refund exceeding net received', async () => {
    paymentRepoMock.recordPayment.mockRejectedValue(conflict('This refund is larger than everything ever received on this tenancy.'));
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      kind: 'refund',
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2026-04-01',
    });
    expect(res.status).toBe(409);
  });

  it('422s on a zero or negative amountCents — rejected at the schema boundary, never reaching the repo', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 0,
      receivedOn: '2026-04-01',
    });
    expect(res.status).toBe(422);
    expect(paymentRepoMock.recordPayment).not.toHaveBeenCalled();
  });

  it('422s on a receivedOn the repo rejects as future-dated', async () => {
    paymentRepoMock.recordPayment.mockRejectedValue(validationFailed({ receivedOn: ['receivedOn cannot be in the future.'] }));
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2099-01-01',
    });
    expect(res.status).toBe(422);
  });

  it('a stray currency field is silently stripped — recordPaymentBody has no currency, the server copies the lease\'s', async () => {
    paymentRepoMock.recordPayment.mockResolvedValue(paymentRow());
    const res = await post(`/v1/leases/${LEASE_ID}/payments`, {
      method: 'bank_transfer',
      amountCents: 100000,
      receivedOn: '2026-04-01',
      currency: 'GBP',
    });
    expect(res.status).toBe(201);
    const [, , , , body] = paymentRepoMock.recordPayment.mock.calls[0]!;
    expect(body).not.toHaveProperty('currency');
  });
});

describe('PATCH /v1/leases/:leaseId/payments/:paymentId', () => {
  it('updates the note and returns 200', async () => {
    paymentRepoMock.updatePaymentNote.mockResolvedValue(paymentRow({ note: 'Paid late again.' }));
    const res = await patch(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}`, { note: 'Paid late again.' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.note).toBe('Paid late again.');
  });

  it('404s when the repo finds no such (lease, payment)', async () => {
    paymentRepoMock.updatePaymentNote.mockResolvedValue(null);
    const res = await patch(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}`, { note: 'x' });
    expect(res.status).toBe(404);
  });

  it('422s on a stray field — updatePaymentNoteBody is .strict()', async () => {
    const res = await patch(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}`, { note: 'x', amountCents: 500 });
    expect(res.status).toBe(422);
    expect(paymentRepoMock.updatePaymentNote).not.toHaveBeenCalled();
  });
});

describe('POST /v1/leases/:leaseId/payments/:paymentId/void', () => {
  it('404s when the repo finds no such (lease, payment)', async () => {
    paymentRepoMock.voidPayment.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, {
      reason: 'Cheque bounced at the bank.',
    });
    expect(res.status).toBe(404);
  });

  it('409s when already voided', async () => {
    paymentRepoMock.voidPayment.mockRejectedValue(conflict('This payment has already been voided.'));
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, {
      reason: 'Cheque bounced at the bank.',
    });
    expect(res.status).toBe(409);
  });

  it('409s when voiding would take net-received negative', async () => {
    paymentRepoMock.voidPayment.mockRejectedValue(
      conflict("Voiding this payment would take this tenancy's net received below zero. Void the related refund first."),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, {
      reason: 'Attempting to void after a refund already spent the room.',
    });
    expect(res.status).toBe(409);
  });

  it('422s on a reason under 10 characters', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, { reason: 'too short' });
    expect(res.status).toBe(422);
    expect(paymentRepoMock.voidPayment).not.toHaveBeenCalled();
  });

  it('200s with the voided payment', async () => {
    paymentRepoMock.voidPayment.mockResolvedValue(
      paymentRow({ voidedAt: new Date('2026-04-02T00:00:00.000Z'), voidedReason: 'Cheque bounced.' }),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, {
      reason: 'Cheque bounced at the bank.',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/leases/:leaseId/payments/:paymentId/correct', () => {
  it('404s when the repo finds no such (lease, payment)', async () => {
    paymentRepoMock.correctPayment.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/correct`, {
      method: 'bank_transfer',
      amountCents: 102000,
      receivedOn: '2026-04-01',
      reason: 'Recorded the wrong amount.',
    });
    expect(res.status).toBe(404);
  });

  it('201s with the successor payment', async () => {
    paymentRepoMock.correctPayment.mockResolvedValue(
      paymentRow({ id: '00000000-0000-7000-8000-00000000d002', supersedesPaymentId: PAYMENT_ID, amountCents: 102000 }),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/correct`, {
      method: 'bank_transfer',
      amountCents: 102000,
      receivedOn: '2026-04-01',
      reason: 'Recorded the wrong amount.',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.supersedesPaymentId).toBe(PAYMENT_ID);
  });

  it('422s on a reason under 10 characters', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/correct`, {
      method: 'bank_transfer',
      amountCents: 102000,
      receivedOn: '2026-04-01',
      reason: 'nope',
    });
    expect(res.status).toBe(422);
  });
});

/* ======================================================================== *
 * §9 landlord-vs-landlord: both path ids are scoped, neither alone is enough
 * ======================================================================== */

describe('§9 landlord-vs-landlord: both path ids are scoped, neither alone is sufficient', () => {
  it("landlord B's void of landlord A's (lease, payment) 404s — the repo's (org, lease, id) resolve returns null before any UPDATE", async () => {
    currentOrgId = 'org_B';
    paymentRepoMock.voidPayment.mockResolvedValue(null);

    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/void`, {
      reason: 'Should never apply — wrong org entirely.',
    });
    expect(res.status).toBe(404);
    expect(paymentRepoMock.voidPayment).toHaveBeenCalledWith('org_B', expect.anything(), LEASE_ID, PAYMENT_ID, 'user_1', expect.anything());
  });

  it("landlord B's correct of landlord A's (lease, payment) 404s", async () => {
    currentOrgId = 'org_B';
    paymentRepoMock.correctPayment.mockResolvedValue(null);

    const res = await post(`/v1/leases/${LEASE_ID}/payments/${PAYMENT_ID}/correct`, {
      method: 'bank_transfer',
      amountCents: 1,
      receivedOn: '2026-04-01',
      reason: 'Should never apply — wrong org entirely.',
    });
    expect(res.status).toBe(404);
  });

  it("landlord B's GET of landlord A's lease payments 404s — resolved via getLease, never the payment list alone", async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.getLease.mockResolvedValue(null); // org B's own getLease never finds org A's lease

    const res = await get(`/v1/leases/${LEASE_ID}/payments`);
    expect(res.status).toBe(404);
    expect(paymentRepoMock.listPayments).not.toHaveBeenCalled();
  });
});

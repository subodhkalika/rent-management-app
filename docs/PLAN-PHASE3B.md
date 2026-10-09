# Phase 3b — Payments, Allocation, Balances, Arrears

Status: plan. Written 2026-10-10, on top of PLAN-PHASE3A (charges, void/correct,
cron) as shipped.

**Scope.** Manual payment recording, FIFO allocation, per-lease and per-chain
balances, the arrears view, and the tenant's own payment history and balance.
**Not** reminders, **not** maintenance, **not** reports, **not** card processing.

## 0. The decisions, in one table
## 1. Stale statements in 3a and V1 that 3b must not inherit
## 2. The `payment` table
## 3. FIFO allocation: one window function, derived, never stored
## 4. Every money edge case, falling out of the allocation
## 5. Balances: per lease, per chain, rent vs deposit
## 6. The arrears view
## 7. The tenant side
## 8. API surface
## 9. The tenant attack walk
## 10. Contract additions, file by file
## 11. Task split
## 12. What 3b leaves for later
## 13. Risks, assumptions, and where I want input

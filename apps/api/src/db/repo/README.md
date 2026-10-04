# Repository layer

Every function that touches an org-owned table lives here, and every one of them:

1. takes `orgId` as its **first parameter**, and
2. includes `orgId` in the `WHERE` clause of **every** read, update and delete.

Route handlers call these functions. Route handlers never import `db`.

`tenancy.guard.test.ts` enforces both rules automatically — it reads every file in
this directory and fails the build on a violation. It is a static check, so it costs
no database and runs on every PR.

## Pattern

```ts
export async function getProperty(orgId: string, id: string) {
  const [row] = await db.select().from(property)
    .where(and(eq(property.orgId, orgId), eq(property.id, id)))
    .limit(1);
  return row ?? null;
}
```

Note the `and(...)`: filtering on `id` alone would let any landlord read any row
whose UUID they happened to learn.

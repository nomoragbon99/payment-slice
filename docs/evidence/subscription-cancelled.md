# Evidence: a cancelled subscription retains access until the period ends

A REAL cancellation was performed on `bob@example.com`'s live subscription, through the actual running application (`POST /api/subscription/cancel`, the same endpoint the "Cancel plan" button on `/billing` calls), and then resumed immediately afterward through the actual "Keep my plan" endpoint (`POST /api/subscription/resume`) so bob's account is left exactly as it was. No new transaction was created: this only ever touches `cancel_at_period_end` and `cancellation_reason` on the existing subscription row (see `src/lib/billing/cancel.ts`) -- it makes no call to Paystack and writes nothing to `payment_log`.

Times below are UTC.

## Before

```json
{
  "billingInterval": "yearly",
  "status": "active",
  "currentPeriodEnd": "2027-09-23T10:24:57.430Z",
  "cancelAtPeriodEnd": false,
  "cancellationReason": null
}
```

## The cancellation

```
POST /api/subscription/cancel
{"reason":"Evidence capture for the assessment brief"}

-> HTTP 200  {"endsOn":"2027-09-23T10:24:57.430Z"}
```

## After: cancelled, but Pro until the period ends

```json
{
  "billingInterval": "yearly",
  "status": "active",
  "currentPeriodEnd": "2027-09-23T10:24:57.430Z",
  "cancelAtPeriodEnd": true,
  "cancellationReason": "Evidence capture for the assessment brief"
}
```

**`status` is still `active`** -- cancelling never revokes access early; it only marks the period as not renewing. `current_period_end` is completely unchanged (2027-09-23T10:24:57.430Z, the exact same instant as before): `describeSubscription()` (`src/lib/billing/subscription.ts`) grants Pro on `status = 'active' AND current_period_end > now()` regardless of `cancel_at_period_end`, so bob keeps full access for the rest of the period he already paid for.

### Screenshot: `subscription-cancelled.png`

The real `/billing` page, signed in as bob, immediately after the cancellation above:
- **Active, will end**
- **Ends on 23 Sep 2027**
- a "Keep my plan" (resume) control in place of "Cancel plan"

This is the application's own rendering of the same row shown in JSON above -- both sourced from the identical `cancel_at_period_end = true`, `current_period_end = 2027-09-23` state.

## Resumed immediately after

```
POST /api/subscription/resume

-> HTTP 200  {"resumed":true}
```

Confirmed back to normal:

```json
{
  "billingInterval": "yearly",
  "status": "active",
  "currentPeriodEnd": "2027-09-23T10:24:57.430Z",
  "cancelAtPeriodEnd": false,
  "cancellationReason": null
}
```

Bob's account is left exactly as it was before this evidence capture: Pro yearly, active, not cancelling, `updated_at` the only column that moved.

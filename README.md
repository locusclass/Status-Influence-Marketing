# gig-marketing

Monorepo for the Gig Marketing platform.

## Stack
- Flutter (Android-first) mobile app
- Fastify + TypeScript API
- PostgreSQL
- Node.js worker for verification jobs
- Railway deployment
- PesaPal Aggregator payments

## Monorepo layout
- `apps/api` Fastify backend
- `apps/worker` verification worker
- `apps/mobile` Flutter app
- `packages/shared` shared zod schemas + types

## Local development
1. Install dependencies:
   - `pnpm install`
2. Configure environment variables (see below).
3. Initialize the database:
   - Apply `apps/api/sql/schema.sql` to your Postgres instance.
4. Start API:
   - `pnpm --filter @gig/api dev`
5. Start worker:
   - `pnpm --filter @gig/worker dev`
6. Run Flutter app:
   - `cd apps/mobile && flutter pub get && flutter run`
7. Run Flutter web:
   - `cd apps/mobile && flutter pub get && flutter run -d chrome`

## PesaPal sandbox configuration
- Use PesaPal sandbox credentials.
- Set `PESAPAL_ENV=sandbox` and `PESAPAL_BASE_URL` to the sandbox API base.
- Register IPN URL to `/api/payments/pesapal/ipn`.

## Railway deployment
- Railway uses Nixpacks and reads `railway.json`.
- Set all environment variables in Railway.
- Do not hardcode ports; API and worker read `PORT`.

## Environment variables
### API
- `PORT`
- `DATABASE_URL`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `UPLOAD_DIR`
- `UPLOAD_SIGNING_SECRET`
- `FINGERPRINT_PEPPER`
- `PESAPAL_ENV` (`sandbox|production`)
- `PESAPAL_BASE_URL`
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`
- `PESAPAL_IPN_ID`
- `PESAPAL_CALLBACK_URL`
- `PESAPAL_PAYOUT_CALLBACK_URL`
- `PESAPAL_PAYOUT_WEBHOOK_SECRET`

### Worker
- `PORT`
- `DATABASE_URL`
- `FINGERPRINT_PEPPER`
- `PESAPAL_ENV`
- `PESAPAL_BASE_URL`
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`
- `PESAPAL_PAYOUT_CALLBACK_URL`
- `PESAPAL_PAYOUT_WEBHOOK_SECRET`
- `API_BASE_URL`

### Mobile
- `API_BASE_URL`
- `PAYMENT_RETURN_URL`
- `PAYMENT_CANCEL_URL`

## Threat model for screen recording verification
- Replay attacks: challenge code + phrase tied to session with expiry.
- Video tampering: histogram spike cut detection, frozen frame detection, timestamp consistency, overlay edge density anomaly.
- Device spoofing: device fingerprint hashed with server-side pepper.
- Metrics manipulation: platform adapter ROI checks and UI pattern hints.
- Double payout: escrow ledger and payout requests are idempotent and enforced by unique constraints.

## Fraud detection heuristics
- Histogram delta spike detection flags abrupt scene cuts.
- Frozen frame detection flags repeated frames beyond a threshold.
- Metadata timestamp consistency validates monotonic timestamps.
- Overlay suspicion detects anomalous ROI edge density spikes suggesting overlays.

## Tests
- Escrow release idempotency tests
- PesaPal webhook validation tests
- Trust score update tests
- Worker job retry tests


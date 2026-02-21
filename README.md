# Bakule

Bakule is a Pan-African escrow and verification infrastructure that formalizes paid social media distribution. It turns informal peer-to-peer promotion into structured, escrow-backed distribution contracts with automated compliance enforcement. The platform enforces distribution integrity, not marketing outcomes.

## Operating modes
- Private Contract Mode: Advertisers and distributors negotiate off-platform, then execute via Bakule. Funds are held in escrow, and payouts release only after verified compliance (content authenticity, posting duration, and validated impression accumulation). A 15% execution fee is applied to successful settlements.
- Open Budget Mode: Advertisers deposit a budget and upload content. The system converts funds into a fixed number of verified impressions using a deterministic pricing model. Qualified distributors claim portions of the campaign, and payouts are calculated strictly per verified unit delivered.

## Verification and risk controls
- AI-driven verification with human review for anomalies.
- Media hashing, timestamp checks, minimum duration enforcement, and engagement velocity analysis.
- Distributor credibility scores based on compliance history and fraud risk weighting.

## Stack
- Fastify + TypeScript API
- PostgreSQL
- Node.js worker for verification jobs
- Railway deployment
- PesaPal Aggregator payments

## Monorepo layout
- `apps/api` Fastify backend
- `apps/worker` verification worker
- `packages/shared` shared zod schemas + types

## Local development
1. Install dependencies:
   - `pnpm install`
2. Configure environment variables (see below).
3. Initialize the database:
   - Apply `apps/api/sql/schema.sql` to your Postgres instance.
4. Start API:
   - `pnpm --filter @bakule/api dev`
5. Start worker:
   - `pnpm --filter @bakule/worker dev`

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

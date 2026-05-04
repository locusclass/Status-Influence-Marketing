# Prime

Prime is a Pan-African escrow and verification infrastructure that formalizes paid social media distribution. It turns informal peer-to-peer promotion into structured, escrow-backed distribution contracts with automated compliance enforcement. The platform enforces distribution integrity, not marketing outcomes.

## Operating modes
- Private Contract Mode: Advertisers and distributors negotiate off-platform, then execute via Prime. Funds are held in escrow, and payouts release only after verified compliance (content authenticity, posting duration, and validated impression accumulation). A 15% execution fee is applied to successful settlements.
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
- YO Uganda mobile money payments

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
   - `pnpm --filter @prime/api dev`
5. Start worker:
   - `pnpm --filter @prime/worker dev`

## YO Uganda payment configuration
- Use YO Uganda `AccountAuthorization` for production collections.
- For production IP whitelisting, set `YO_PROXY_URL` to `http://34.79.189.141:3000/yo`.
- The final YO task URL resolves to `http://34.79.189.141:3000/yo/ybs/task.php`.
- `YO_BASE_URL` and `YO_API_URL` remain supported for backward compatibility, but `YO_PROXY_URL` takes priority.
- Direct YO hosts are rewritten back to the gateway unless `YO_ALLOW_DIRECT_API_BYPASS=true`.
- Leave `YO_API_URL_FALLBACK` on the gateway unless you explicitly want a different fallback route.
- Set `YO_AUTHORIZATION`.
- `YO_API_USERNAME` and `YO_API_PASSWORD` are only needed when you intentionally use the legacy direct API credentials.
- Collections in this codebase use status polling through `/api/payments/yo-uganda/verify`.

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
  - Comma-separated origins. Wildcards are supported (example: `http://localhost:*`).
- `UPLOAD_SIGNING_SECRET`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_STORAGE_BUCKET`
- `GOOGLE_CLIENT_ID`
  - Google OAuth web client ID used by Firebase Auth. Comma-separate multiple IDs if needed.
- `FINGERPRINT_PEPPER`
- `YO_PROXY_URL`
- `YO_BASE_URL`
- `YO_API_URL`
- `YO_API_URL_FALLBACK`
- `YO_ALLOW_DIRECT_API_BYPASS`
- `YO_AUTHORIZATION`
- `YO_API_USERNAME`
- `YO_API_PASSWORD`
- `YO_WEBHOOK_SECRET_HASH`

### Worker
- `PORT`
- `DATABASE_URL`
- `FINGERPRINT_PEPPER`
- `VERIFIER_PROVIDER` (`python_bot|deterministic|gemini|mock`)
- `PYTHON_EXECUTABLE` (for python bot, e.g. `python3`)
- `PYTHON_VERIFIER_SCRIPT` (defaults to `apps/worker/scripts/wa_status_verifier.py`)
- `WA_VERIFIER_FPS`
- `WA_VERIFIER_MAX_SECONDS`
- `YO_PROXY_URL`
- `YO_BASE_URL`
- `YO_API_URL`
- `YO_ALLOW_DIRECT_API_BYPASS`
- `YO_AUTHORIZATION`
- `YO_API_USERNAME`
- `YO_API_PASSWORD`
- `YO_WEBHOOK_SECRET_HASH`
- `API_BASE_URL`

## Threat model for screen recording verification
- Replay attacks: challenge code + phrase tied to session with expiry.
- Strict client trace gate: submission rejected unless 58-75 second recording window and all required random steps are present.
- Video tampering: histogram spike cut detection, frozen frame detection, timestamp consistency, overlay edge density anomaly.
- Python bot adjudication: ffprobe + OCR + liveness + tamper heuristics produce machine verdict and score report stored on proof metadata.
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
- YO Uganda payment validation tests
- Trust score update tests
- Worker job retry tests


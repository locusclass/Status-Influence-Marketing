-- Add AI verification columns to proofs table
ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS ai_provider TEXT,
  ADD COLUMN IF NOT EXISTS ai_model TEXT,
  ADD COLUMN IF NOT EXISTS viewer_count_detected INTEGER,
  ADD COLUMN IF NOT EXISTS viewer_count_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS campaign_visible BOOLEAN,
  ADD COLUMN IF NOT EXISTS campaign_match_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS whatsapp_ui_detected BOOLEAN,
  ADD COLUMN IF NOT EXISTS authenticity_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS suspected_tampering BOOLEAN,
  ADD COLUMN IF NOT EXISTS fraud_risk_score INTEGER,
  ADD COLUMN IF NOT EXISTS fraud_signals JSONB,
  ADD COLUMN IF NOT EXISTS missing_evidence JSONB,
  ADD COLUMN IF NOT EXISTS local_warnings JSONB,
  ADD COLUMN IF NOT EXISTS ai_recommendation TEXT,
  ADD COLUMN IF NOT EXISTS reasoning_summary TEXT,
  ADD COLUMN IF NOT EXISTS raw_ai_response JSONB,
  ADD COLUMN IF NOT EXISTS reviewed_by_admin_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_failure_reason TEXT;

-- Index for admin review queue
CREATE INDEX IF NOT EXISTS proofs_verification_status_idx ON proofs (verification_status);
CREATE INDEX IF NOT EXISTS proofs_decision_status_idx ON proofs (decision, status);

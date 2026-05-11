BEGIN;

CREATE TEMP TABLE tmp_unsupported_campaign_ids AS
WITH RECURSIVE unsupported_campaigns AS (
  SELECT id
  FROM campaigns
  WHERE platform IN ('TIKTOK', 'X')

  UNION

  SELECT child.id
  FROM campaigns child
  JOIN unsupported_campaigns parent
    ON child.parent_campaign_id = parent.id
)
SELECT DISTINCT id
FROM unsupported_campaigns;

CREATE TEMP TABLE tmp_unsupported_proof_ids AS
SELECT p.id
FROM proofs p
JOIN verification_sessions s
  ON s.id = p.session_id
WHERE s.campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids);

DELETE FROM job_queue
WHERE payload ->> 'proof_id' IN (
  SELECT id::text
  FROM tmp_unsupported_proof_ids
);

DO $$
BEGIN
  IF to_regclass('public.content_submissions') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM content_submissions
      WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids)
         OR proof_id IN (SELECT id FROM tmp_unsupported_proof_ids)
    $sql$;
  END IF;

  IF to_regclass('public.creator_accounts') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM creator_accounts
      WHERE platform IN ('TIKTOK', 'X')
    $sql$;
  END IF;
END $$;

DELETE FROM proofs
WHERE id IN (SELECT id FROM tmp_unsupported_proof_ids);

DELETE FROM verification_sessions
WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids);

DELETE FROM contracts
WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids);

DELETE FROM pesapal_transactions
WHERE escrow_id IN (
  SELECT id
  FROM escrow_ledger
  WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids)
);

DELETE FROM escrow_ledger
WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids);

DELETE FROM earnings_ledger
WHERE campaign_id IN (SELECT id FROM tmp_unsupported_campaign_ids);

DELETE FROM campaigns
WHERE id IN (SELECT id FROM tmp_unsupported_campaign_ids);

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_platform_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_platform_check
  CHECK (platform IN ('WHATSAPP_STATUS'));

ALTER TABLE verification_sessions
  DROP CONSTRAINT IF EXISTS verification_sessions_platform_check;

ALTER TABLE verification_sessions
  ADD CONSTRAINT verification_sessions_platform_check
  CHECK (platform IN ('WHATSAPP_STATUS'));

COMMIT;

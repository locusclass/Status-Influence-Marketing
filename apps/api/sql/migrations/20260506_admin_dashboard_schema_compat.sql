ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS ambassador_id UUID;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS distributor_id UUID;

UPDATE contracts
SET ambassador_id = COALESCE(ambassador_id, distributor_id),
    distributor_id = COALESCE(distributor_id, ambassador_id)
WHERE ambassador_id IS NULL
   OR distributor_id IS NULL
   OR ambassador_id IS DISTINCT FROM distributor_id;

CREATE OR REPLACE FUNCTION sync_contract_participant_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_participant UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.ambassador_id IS DISTINCT FROM OLD.ambassador_id THEN
      resolved_participant := NEW.ambassador_id;
    ELSIF NEW.distributor_id IS DISTINCT FROM OLD.distributor_id THEN
      resolved_participant := NEW.distributor_id;
    ELSE
      resolved_participant := COALESCE(NEW.ambassador_id, NEW.distributor_id);
    END IF;
  ELSE
    resolved_participant := COALESCE(NEW.ambassador_id, NEW.distributor_id);
  END IF;

  NEW.ambassador_id := resolved_participant;
  NEW.distributor_id := resolved_participant;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contracts_sync_participant_columns
ON contracts;

CREATE TRIGGER contracts_sync_participant_columns
BEFORE INSERT OR UPDATE ON contracts
FOR EACH ROW
EXECUTE FUNCTION sync_contract_participant_columns();

ALTER TABLE campaign_creation_drafts
  ADD COLUMN IF NOT EXISTS business_id UUID;

ALTER TABLE campaign_creation_drafts
  ADD COLUMN IF NOT EXISTS advertiser_id UUID;

UPDATE campaign_creation_drafts
SET business_id = COALESCE(business_id, advertiser_id),
    advertiser_id = COALESCE(advertiser_id, business_id)
WHERE business_id IS NULL
   OR advertiser_id IS NULL
   OR business_id IS DISTINCT FROM advertiser_id;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_creation_drafts_business_id_key
  ON campaign_creation_drafts (business_id);

CREATE OR REPLACE FUNCTION sync_campaign_creation_draft_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_owner UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
      resolved_owner := NEW.business_id;
    ELSIF NEW.advertiser_id IS DISTINCT FROM OLD.advertiser_id THEN
      resolved_owner := NEW.advertiser_id;
    ELSE
      resolved_owner := COALESCE(NEW.business_id, NEW.advertiser_id);
    END IF;
  ELSE
    resolved_owner := COALESCE(NEW.business_id, NEW.advertiser_id);
  END IF;

  NEW.business_id := resolved_owner;
  NEW.advertiser_id := resolved_owner;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaign_creation_drafts_sync_owner_columns
ON campaign_creation_drafts;

CREATE TRIGGER campaign_creation_drafts_sync_owner_columns
BEFORE INSERT OR UPDATE ON campaign_creation_drafts
FOR EACH ROW
EXECUTE FUNCTION sync_campaign_creation_draft_owner_columns();

ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE proofs
SET updated_at = COALESCE(updated_at, created_at, NOW())
WHERE updated_at IS NULL;

-- Keep public product pages live for the campaign duration plus one hour.
-- This aligns listing/product-page expiry with the beneficiary contract window.

UPDATE advert_listings al
SET
  campaign_start_at = COALESCE(
    c.start_date::TIMESTAMPTZ,
    al.campaign_start_at,
    al.created_at
  ),
  campaign_end_at = COALESCE(
    c.end_date::TIMESTAMPTZ,
    COALESCE(c.start_date::TIMESTAMPTZ, COALESCE(al.campaign_start_at, al.created_at))
      + (COALESCE(c.terms_keep_hours, 12) * INTERVAL '1 hour')
  ) + INTERVAL '1 hour',
  expires_at = COALESCE(
    c.end_date::TIMESTAMPTZ,
    COALESCE(c.start_date::TIMESTAMPTZ, COALESCE(al.campaign_start_at, al.created_at))
      + (COALESCE(c.terms_keep_hours, 12) * INTERVAL '1 hour')
  ) + INTERVAL '1 hour'
FROM campaigns c
WHERE c.id = al.campaign_id
  AND COALESCE(al.admin_keep_alive, FALSE) = FALSE;

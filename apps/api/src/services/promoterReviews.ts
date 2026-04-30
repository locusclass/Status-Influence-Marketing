export type PromoterReviewSummary = {
  average_rating: number;
  rating_count: number;
  latest_comment: string | null;
};

export async function ensurePromoterReviewsSchema(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS promoter_profile_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      promoter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      advertiser_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contract_id UUID NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT promoter_profile_reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS promoter_profile_reviews_promoter_idx
    ON promoter_profile_reviews (promoter_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS promoter_profile_reviews_advertiser_idx
    ON promoter_profile_reviews (advertiser_id, created_at DESC)
  `);
}

function normalizeComment(value: unknown) {
  const comment = String(value ?? '').trim();
  return comment.length > 0 ? comment : null;
}

export async function loadPromoterReviewSummaryMap(
  client: any,
  promoterIds: string[]
) {
  const ids = Array.from(
    new Set(
      promoterIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  );
  if (ids.length === 0) {
    return new Map<string, PromoterReviewSummary>();
  }

  const res = await client.query(
    `
    WITH review_rows AS (
      SELECT
        promoter_id,
        rating,
        NULLIF(BTRIM(comment), '') AS comment,
        created_at
      FROM promoter_profile_reviews
      WHERE promoter_id = ANY($1::uuid[])
    ),
    latest_comments AS (
      SELECT DISTINCT ON (promoter_id)
        promoter_id,
        comment
      FROM review_rows
      WHERE comment IS NOT NULL
      ORDER BY promoter_id, created_at DESC
    )
    SELECT
      review_rows.promoter_id,
      ROUND(AVG(review_rows.rating)::numeric, 1)::numeric AS average_rating,
      COUNT(*)::int AS rating_count,
      latest_comments.comment AS latest_comment
    FROM review_rows
    LEFT JOIN latest_comments
      ON latest_comments.promoter_id = review_rows.promoter_id
    GROUP BY review_rows.promoter_id, latest_comments.comment
    `,
    [ids]
  );

  const map = new Map<string, PromoterReviewSummary>();
  for (const row of res.rows) {
    map.set(String(row.promoter_id), {
      average_rating: Number(row.average_rating ?? 0),
      rating_count: Math.max(0, Number(row.rating_count ?? 0)),
      latest_comment: normalizeComment(row.latest_comment),
    });
  }
  return map;
}

export async function listPromoterReviews(
  client: any,
  promoterId: string,
  limit = 12
) {
  const res = await client.query(
    `
    SELECT
      review.id,
      review.promoter_id,
      review.advertiser_id,
      review.contract_id,
      review.rating,
      review.comment,
      review.created_at,
      review.updated_at,
      advertiser.public_id AS advertiser_public_id,
      COALESCE(
        NULLIF(advertiser.full_name, ''),
        NULLIF(advertiser.email, ''),
        NULLIF(advertiser.phone, ''),
        'Advertiser'
      ) AS advertiser_display_name
    FROM promoter_profile_reviews review
    JOIN users advertiser ON advertiser.id = review.advertiser_id
    WHERE review.promoter_id = $1
    ORDER BY review.updated_at DESC, review.created_at DESC
    LIMIT $2
    `,
    [promoterId, Math.min(Math.max(limit, 1), 30)]
  );

  return res.rows.map((row: any) => ({
    id: String(row.id),
    promoter_id: String(row.promoter_id),
    advertiser_id: String(row.advertiser_id),
    contract_id: String(row.contract_id),
    rating: Math.max(1, Number(row.rating ?? 1)),
    comment: String(row.comment ?? '').trim(),
    created_at:
      row.created_at == null ? null : new Date(String(row.created_at)).toISOString(),
    updated_at:
      row.updated_at == null ? null : new Date(String(row.updated_at)).toISOString(),
    advertiser: {
      id: String(row.advertiser_id),
      public_id: String(row.advertiser_public_id ?? ''),
      display_name: String(row.advertiser_display_name ?? 'Advertiser'),
    },
  }));
}

export async function loadLatestCompletedContractForReview(
  client: any,
  advertiserId: string,
  promoterId: string
) {
  const res = await client.query(
    `
    SELECT
      ctr.id,
      ctr.status,
      ctr.completed_at,
      ctr.created_at
    FROM contracts ctr
    JOIN campaigns c ON c.id = ctr.campaign_id
    WHERE c.advertiser_id = $1
      AND ctr.distributor_id = $2
      AND ctr.status = 'COMPLETED'
    ORDER BY COALESCE(ctr.completed_at, ctr.created_at) DESC
    LIMIT 1
    `,
    [advertiserId, promoterId]
  );
  return res.rows[0] ?? null;
}

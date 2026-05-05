export async function ensureAmbassadorReviewsSchema(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS ambassador_profile_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ambassador_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contract_id UUID NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ambassador_profile_reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS ambassador_profile_reviews_ambassador_idx
    ON ambassador_profile_reviews (ambassador_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS ambassador_profile_reviews_business_idx
    ON ambassador_profile_reviews (business_id, created_at DESC)
  `);
}
function normalizeComment(value) {
    const comment = String(value ?? '').trim();
    return comment.length > 0 ? comment : null;
}
export async function loadAmbassadorReviewSummaryMap(client, ambassadorIds) {
    const ids = Array.from(new Set(ambassadorIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)));
    if (ids.length === 0) {
        return new Map();
    }
    const res = await client.query(`
    WITH review_rows AS (
      SELECT
        ambassador_id,
        rating,
        NULLIF(BTRIM(comment), '') AS comment,
        created_at
      FROM ambassador_profile_reviews
      WHERE ambassador_id = ANY($1::uuid[])
    ),
    latest_comments AS (
      SELECT DISTINCT ON (ambassador_id)
        ambassador_id,
        comment
      FROM review_rows
      WHERE comment IS NOT NULL
      ORDER BY ambassador_id, created_at DESC
    )
    SELECT
      review_rows.ambassador_id,
      ROUND(AVG(review_rows.rating)::numeric, 1)::numeric AS average_rating,
      COUNT(*)::int AS rating_count,
      latest_comments.comment AS latest_comment
    FROM review_rows
    LEFT JOIN latest_comments
      ON latest_comments.ambassador_id = review_rows.ambassador_id
    GROUP BY review_rows.ambassador_id, latest_comments.comment
    `, [ids]);
    const map = new Map();
    for (const row of res.rows) {
        map.set(String(row.ambassador_id), {
            average_rating: Number(row.average_rating ?? 0),
            rating_count: Math.max(0, Number(row.rating_count ?? 0)),
            latest_comment: normalizeComment(row.latest_comment),
        });
    }
    return map;
}
export async function listAmbassadorReviews(client, ambassadorId, limit = 12) {
    const res = await client.query(`
    SELECT
      review.id,
      review.ambassador_id,
      review.business_id,
      review.contract_id,
      review.rating,
      review.comment,
      review.created_at,
      review.updated_at,
      business.public_id AS business_public_id,
      COALESCE(
        NULLIF(business.full_name, ''),
        NULLIF(business.email, ''),
        NULLIF(business.phone, ''),
        'Business'
      ) AS business_display_name
    FROM ambassador_profile_reviews review
    JOIN users business ON business.id = review.business_id
    WHERE review.ambassador_id = $1
    ORDER BY review.updated_at DESC, review.created_at DESC
    LIMIT $2
    `, [ambassadorId, Math.min(Math.max(limit, 1), 30)]);
    return res.rows.map((row) => ({
        id: String(row.id),
        ambassador_id: String(row.ambassador_id),
        business_id: String(row.business_id),
        contract_id: String(row.contract_id),
        rating: Math.max(1, Number(row.rating ?? 1)),
        comment: String(row.comment ?? '').trim(),
        created_at: row.created_at == null ? null : new Date(String(row.created_at)).toISOString(),
        updated_at: row.updated_at == null ? null : new Date(String(row.updated_at)).toISOString(),
        business: {
            id: String(row.business_id),
            public_id: String(row.business_public_id ?? ''),
            display_name: String(row.business_display_name ?? 'Business'),
        },
    }));
}
export async function loadLatestCompletedContractForReview(client, businessId, ambassadorId) {
    const res = await client.query(`
    SELECT
      ctr.id,
      ctr.status,
      ctr.completed_at,
      ctr.created_at
    FROM contracts ctr
    JOIN campaigns c ON c.id = ctr.campaign_id
    WHERE c.business_id = $1
      AND ctr.ambassador_id = $2
      AND ctr.status = 'COMPLETED'
    ORDER BY COALESCE(ctr.completed_at, ctr.created_at) DESC
    LIMIT 1
    `, [businessId, ambassadorId]);
    return res.rows[0] ?? null;
}

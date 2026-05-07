export function buildActiveViewerVerificationJoin(
  userAlias = 'u',
  joinAlias = 'viewer_verification'
) {
  return `
    LEFT JOIN LATERAL (
      SELECT
        rec.id,
        COALESCE(rec.approved_viewer_count, 0)::int AS approved_viewer_count,
        rec.reviewed_at,
        rec.expires_at
      FROM ambassador_verification_recordings rec
      WHERE rec.user_id = ${userAlias}.id
        AND rec.status = 'APPROVED'
        AND COALESCE(rec.expires_at, NOW()) >= NOW()
      ORDER BY
        COALESCE(rec.reviewed_at, rec.created_at) DESC,
        rec.created_at DESC
      LIMIT 1
    ) ${joinAlias} ON TRUE
  `;
}

export function buildViewerVerificationFields(joinAlias = 'viewer_verification') {
  return `
    CASE WHEN ${joinAlias}.id IS NOT NULL THEN TRUE ELSE FALSE END AS viewer_count_verified,
    COALESCE(${joinAlias}.approved_viewer_count, 0)::int AS verified_viewer_count,
    ${joinAlias}.reviewed_at AS viewer_count_verified_at,
    ${joinAlias}.expires_at AS viewer_count_verification_expires_at
  `;
}

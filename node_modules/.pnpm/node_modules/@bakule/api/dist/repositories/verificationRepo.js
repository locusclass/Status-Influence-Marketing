export class VerificationRepo {
    async createSession(client, input) {
        const res = await client.query(`INSERT INTO verification_sessions
      (user_id, campaign_id, platform, challenge_code, challenge_phrase, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`, [
            input.user_id,
            input.campaign_id,
            input.platform,
            input.challenge_code,
            input.challenge_phrase,
            input.expires_at
        ]);
        return res.rows[0];
    }
    async getSession(client, sessionId) {
        const res = await client.query('SELECT * FROM verification_sessions WHERE id=$1', [sessionId]);
        return res.rows[0];
    }
    async createProof(client, input) {
        const res = await client.query(`INSERT INTO proofs (session_id, user_id, video_url)
       VALUES ($1,$2,$3) RETURNING *`, [input.session_id, input.user_id, input.video_url]);
        return res.rows[0];
    }
    async updateProofResult(client, proofId, result) {
        const res = await client.query(`UPDATE proofs
       SET decision=$2, observed_views=$3, observed_post_hash=$4, challenge_seen=$5, confidence=$6,
           status=$2
       WHERE id=$1 RETURNING *`, [
            proofId,
            result.decision,
            result.observed_views,
            result.observed_post_hash,
            result.challenge_seen,
            result.confidence
        ]);
        return res.rows[0];
    }
    async insertDeviceFingerprint(client, userId, fingerprintHash) {
        const res = await client.query('INSERT INTO device_fingerprints (user_id, fingerprint_hash) VALUES ($1,$2) RETURNING *', [userId, fingerprintHash]);
        return res.rows[0];
    }
}

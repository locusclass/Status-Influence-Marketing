export class TrustRepo {
    async getTrust(client, userId) {
        const res = await client.query('SELECT * FROM trust_scores WHERE user_id=$1', [userId]);
        return res.rows[0];
    }
    async ensureTrust(client, userId) {
        const existing = await this.getTrust(client, userId);
        if (existing)
            return existing;
        const res = await client.query('INSERT INTO trust_scores (user_id) VALUES ($1) RETURNING *', [userId]);
        return res.rows[0];
    }
    async addEvent(client, userId, eventType, delta) {
        await client.query('INSERT INTO trust_events (user_id, event_type, delta) VALUES ($1,$2,$3)', [userId, eventType, delta]);
        const current = await this.ensureTrust(client, userId);
        const nextScore = Math.max(0, Math.min(100, current.score + delta));
        const updated = await client.query('UPDATE trust_scores SET score=$2, updated_at=now() WHERE user_id=$1 RETURNING *', [userId, nextScore]);
        return updated.rows[0];
    }
}

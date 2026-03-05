export class JobRepo {
    async enqueue(client, jobType, payload) {
        const res = await client.query('INSERT INTO job_queue (job_type, payload) VALUES ($1,$2) RETURNING *', [jobType, payload]);
        return res.rows[0];
    }
    async updateJob(client, jobId, status, attempts, lastError, retryReason) {
        const res = await client.query('UPDATE job_queue SET status=$2, attempts=$3, last_error=$4, retry_reason=$5, updated_at=now() WHERE id=$1 RETURNING *', [jobId, status, attempts, lastError ?? null, retryReason ?? null]);
        return res.rows[0];
    }
}

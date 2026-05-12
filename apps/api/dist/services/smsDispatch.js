import { withTransaction } from '../db.js';
import { AFRICAS_TALKING_SMS_PROVIDER, sendAfricaTalkingSms, } from './sms.js';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function normalizeUuid(value) {
    const text = String(value ?? '').trim();
    return UUID_PATTERN.test(text) ? text : null;
}
function maskPhone(phone) {
    const text = String(phone ?? '').trim();
    if (text.length <= 4) {
        return text || null;
    }
    return `***${text.slice(-4)}`;
}
function serializeProviderResponse(result) {
    if (result.response) {
        return {
            http_status: result.response.httpStatus,
            body: result.response.body,
            raw_text: result.response.rawText,
            recipient: result.response.recipient,
            error: result.error,
        };
    }
    return {
        error: result.error,
    };
}
export async function ensureSmsSchema(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS sms_logs_user_created_idx
    ON sms_logs (user_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS sms_logs_provider_created_idx
    ON sms_logs (provider, created_at DESC)
  `);
}
async function insertSmsLog(job, result) {
    try {
        return await withTransaction(async (client) => {
            await ensureSmsSchema(client);
            const inserted = await client.query(`
        INSERT INTO sms_logs (
          user_id,
          phone,
          message,
          provider,
          status,
          provider_response
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING id
        `, [
                normalizeUuid(job.userId),
                result.normalizedPhone ?? String(job.phone ?? '').trim(),
                job.message,
                AFRICAS_TALKING_SMS_PROVIDER,
                result.providerStatus,
                JSON.stringify(serializeProviderResponse(result)),
            ]);
            return String(inserted.rows[0]?.id ?? '').trim() || null;
        });
    }
    catch (error) {
        console.error('[sms] failed to write sms_logs entry', {
            err: error instanceof Error ? error.message : String(error),
            user_id: normalizeUuid(job.userId),
            phone: maskPhone(result.normalizedPhone ?? job.phone),
        });
        return null;
    }
}
export async function dispatchSmsJob(job) {
    const result = await sendAfricaTalkingSms({
        phone: job.phone,
        message: job.message,
    });
    const logId = await insertSmsLog(job, result);
    if (!result.ok) {
        console.warn('[sms] delivery failed', {
            provider: AFRICAS_TALKING_SMS_PROVIDER,
            user_id: normalizeUuid(job.userId),
            phone: maskPhone(result.normalizedPhone ?? job.phone),
            status: result.providerStatus,
            error: result.error,
        });
    }
    return {
        ...result,
        userId: normalizeUuid(job.userId),
        phone: job.phone,
        message: job.message,
        logId,
    };
}
export async function dispatchSmsJobs(jobs) {
    const results = [];
    for (const job of jobs) {
        results.push(await dispatchSmsJob(job));
    }
    return results;
}
export function queueSmsDispatch(jobs, logger, context) {
    if (jobs.length === 0) {
        return;
    }
    void dispatchSmsJobs(jobs)
        .then((results) => {
        const sentCount = results.filter((result) => result.ok).length;
        const skippedCount = results.filter((result) => result.providerStatus === 'SKIPPED').length;
        const failures = results
            .filter((result) => !result.ok)
            .map((result) => ({
            user_id: result.userId,
            phone: maskPhone(result.normalizedPhone ?? result.phone),
            status: result.providerStatus,
            error: result.error,
            log_id: result.logId,
            http_status: result.response?.httpStatus ?? null,
        }));
        if (logger?.warn) {
            logger.warn({
                context: context ?? null,
                queued_count: jobs.length,
                sent_count: sentCount,
                skipped_count: skippedCount,
                failed_count: failures.length,
            }, 'sms_dispatch_completed');
        }
        if (failures.length > 0 && logger?.warn) {
            logger.warn({
                context: context ?? null,
                failed_count: failures.length,
                failures,
            }, 'sms_dispatch_partial_failure');
        }
    })
        .catch((error) => {
        if (logger?.error) {
            logger.error({
                context: context ?? null,
                err: error,
            }, 'sms_dispatch_failed');
        }
    });
}

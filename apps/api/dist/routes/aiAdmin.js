import { GoogleGenerativeAI } from '@google/generative-ai';
import { withTransaction } from '../db.js';
import { config } from '../config.js';
import { resolveLiveDashboardAccess, isSuperDashboardAccess, } from '../services/adminTenant.js';
async function fetchSystemContext(client) {
    const now = new Date().toISOString();
    const [jobStats, proofStats, campaignStats, failedJobs, payoutStats, ambassadorCount, recentProofs] = await Promise.all([
        client.query(`
        SELECT job_type, status, COUNT(*) AS count
        FROM job_queue
        WHERE created_at > now() - interval '24 hours'
        GROUP BY job_type, status
        ORDER BY job_type, status
      `),
        client.query(`
        SELECT status, verification_status, COUNT(*) AS count
        FROM proofs
        GROUP BY status, verification_status
        ORDER BY status
      `),
        client.query(`
        SELECT status, COUNT(*) AS count
        FROM campaigns
        GROUP BY status
        ORDER BY status
      `),
        client.query(`
        SELECT job_type, error, created_at
        FROM job_queue
        WHERE status = 'FAILED'
        ORDER BY created_at DESC
        LIMIT 10
      `),
        client.query(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
        FROM payouts
        WHERE created_at > now() - interval '7 days'
        GROUP BY status
        ORDER BY status
      `),
        client.query(`
        SELECT COUNT(*) AS count
        FROM users
        WHERE role = 'AMBASSADOR'
      `),
        client.query(`
        SELECT p.id, p.status, p.verification_status, p.ai_recommendation,
               p.fraud_risk_score, p.viewer_count_detected, p.created_at,
               c.title AS campaign_title
        FROM proofs p
        LEFT JOIN verification_sessions vs ON p.session_id = vs.id
        LEFT JOIN campaigns c ON vs.campaign_id = c.id
        ORDER BY p.created_at DESC
        LIMIT 5
      `),
    ]);
    const lines = [
        `REAL-TIME SYSTEM SNAPSHOT — ${now}`,
        '',
        '## JOB QUEUE (last 24h)',
        ...(jobStats.rows.length
            ? jobStats.rows.map((r) => `  ${r.job_type} | ${r.status}: ${r.count}`)
            : ['  No jobs in the last 24h']),
        '',
        '## PROOF VERIFICATION',
        ...(proofStats.rows.length
            ? proofStats.rows.map((r) => `  status=${r.status} verification=${r.verification_status ?? 'N/A'}: ${r.count}`)
            : ['  No proofs found']),
        '',
        '## CAMPAIGNS',
        ...(campaignStats.rows.length
            ? campaignStats.rows.map((r) => `  ${r.status}: ${r.count}`)
            : ['  No campaigns found']),
        '',
        '## PAYOUTS (last 7 days)',
        ...(payoutStats.rows.length
            ? payoutStats.rows.map((r) => `  ${r.status}: ${r.count} payouts, total UGX ${r.total}`)
            : ['  No payouts in the last 7 days']),
        '',
        `## AMBASSADORS: ${ambassadorCount.rows[0]?.count ?? 0} registered`,
        '',
        '## RECENT PROOFS (latest 5)',
        ...(recentProofs.rows.length
            ? recentProofs.rows.map((r) => `  [${String(r.id).slice(0, 8)}] "${r.campaign_title ?? 'unknown'}" status=${r.status} verification=${r.verification_status ?? 'N/A'} ai_rec=${r.ai_recommendation ?? 'N/A'} fraud=${r.fraud_risk_score ?? 'N/A'} views=${r.viewer_count_detected ?? 'N/A'} at=${r.created_at}`)
            : ['  No proofs yet']),
        '',
        '## RECENT FAILED JOBS',
        ...(failedJobs.rows.length
            ? failedJobs.rows.map((r) => `  ${r.job_type} at ${r.created_at}: ${r.error ?? 'no error message'}`)
            : ['  None']),
    ];
    return lines.join('\n');
}
export async function aiAdminRoutes(app) {
    app.post('/admin/ai/chat', { preHandler: [app.authenticate] }, async (request, reply) => {
        const access = await withTransaction((client) => resolveLiveDashboardAccess(client, request));
        if (!access || !isSuperDashboardAccess(access)) {
            reply.code(403);
            return { error: 'super_admin_required' };
        }
        if (!config.gemini.apiKey.trim()) {
            reply.code(503);
            return {
                error: 'gemini_not_configured',
                detail: 'GEMINI_API_KEY is not available in the API service environment.',
            };
        }
        const body = request.body;
        const message = body?.message?.trim() ?? '';
        if (!message) {
            reply.code(400);
            return { error: 'message_required' };
        }
        const systemContext = await withTransaction((client) => fetchSystemContext(client));
        const systemInstruction = `You are the AI Super Admin for Prime Status — an influencer marketing platform where ambassadors post WhatsApp Status ads and earn money per verified view.

You have read access to the live backend. A real-time data snapshot is provided below.

YOUR ROLE
- Analyze system state, explain what is happening, and surface issues proactively.
- Answer questions about campaigns, proofs, payouts, job queue, ambassadors, and verifications.
- Suggest corrective actions with specific steps — but only carry out a write/mutation when the human super admin explicitly confirms.
- Be concise. Use bullet points. Use exact numbers from the snapshot.

CONSTRAINTS
- Never fabricate data. Base answers only on the snapshot or known system logic.
- For any write action, state exactly what you would do and wait for human confirmation before proceeding.
- If needed data is absent from the snapshot, say so and suggest a specific SQL query.

${systemContext}`;
        const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
        const model = genAI.getGenerativeModel({
            model: config.gemini.verificationModel ?? 'gemini-2.0-flash',
            systemInstruction,
        });
        const history = (body.history ?? []).map((h) => ({
            role: h.role,
            parts: [{ text: h.content }],
        }));
        try {
            const chat = model.startChat({ history });
            const result = await chat.sendMessage(message);
            const responseText = result.response.text();
            return { response: responseText };
        }
        catch (error) {
            request.log.error({ err: error }, 'gemini_admin_chat_failed');
            reply.code(502);
            return {
                error: 'gemini_request_failed',
                detail: error instanceof Error ? error.message : 'Gemini request failed',
            };
        }
    });
}

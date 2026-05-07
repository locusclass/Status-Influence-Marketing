import { ADMIN_MODULE_AUDIT_LOGS, ADMIN_MODULE_CAMPAIGNS, ADMIN_MODULE_JOBS, ADMIN_MODULE_PAYOUT_REQUESTS, ADMIN_MODULE_PROOFS, ADMIN_MODULE_RISK, } from '@prime/shared';
import { hasAdminModuleAccess, appendDashboardTenantScope, } from './adminTenant.js';
const DEFAULT_SLA_MINUTES = 10;
const DEFAULT_ACK_MINUTES = 5;
const MAX_SETTING_MINUTES = 120;
const MAX_MESSAGE_LENGTH = 2000;
function appendScope(state, access, scope) {
    appendDashboardTenantScope(state, access, scope);
}
function normalizeText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : fallback;
}
function normalizeNullableText(value) {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : null;
}
function normalizeTimestamp(value) {
    const text = normalizeNullableText(value);
    if (!text) {
        return null;
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function parsePositiveSetting(value, fallback, max = MAX_SETTING_MINUTES) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(numeric), 1), max);
}
function nowIso() {
    return new Date().toISOString();
}
function addMinutes(timestamp, minutes) {
    if (!timestamp) {
        return null;
    }
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return new Date(parsed.getTime() + minutes * 60 * 1000).toISOString();
}
function minTimestamp(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}
function compareTasks(a, b) {
    const actionableCompare = Number(b.actionable) - Number(a.actionable);
    if (actionableCompare !== 0) {
        return actionableCompare;
    }
    const priorityCompare = priorityWeight(b.priority) - priorityWeight(a.priority);
    if (priorityCompare !== 0) {
        return priorityCompare;
    }
    const aDeadline = a.deadline_at == null ? Infinity : Date.parse(a.deadline_at);
    const bDeadline = b.deadline_at == null ? Infinity : Date.parse(b.deadline_at);
    if (aDeadline !== bDeadline) {
        return aDeadline - bDeadline;
    }
    const aCreated = a.created_at == null ? 0 : Date.parse(a.created_at);
    const bCreated = b.created_at == null ? 0 : Date.parse(b.created_at);
    if (aCreated !== bCreated) {
        return bCreated - aCreated;
    }
    return a.title.localeCompare(b.title);
}
function priorityWeight(value) {
    switch (value) {
        case 'CRITICAL':
            return 4;
        case 'URGENT':
            return 3;
        case 'MONITOR':
            return 2;
        default:
            return 1;
    }
}
function priorityFor(deadlineAt) {
    if (!deadlineAt) {
        return 'MONITOR';
    }
    const remainingMs = Date.parse(deadlineAt) - Date.now();
    if (remainingMs < 0) {
        return 'CRITICAL';
    }
    if (remainingMs <= 3 * 60 * 1000) {
        return 'URGENT';
    }
    return 'MONITOR';
}
function summarizeTasks(tasks) {
    const countsByCategory = {};
    let actionable = 0;
    let claimed = 0;
    let breached = 0;
    let dueSoon = 0;
    let activeAlarm = 0;
    for (const task of tasks) {
        countsByCategory[task.category] = (countsByCategory[task.category] ?? 0) + 1;
        if (task.actionable) {
            actionable += 1;
        }
        if (task.claim.user_id) {
            claimed += 1;
        }
        if (task.breached_sla) {
            breached += 1;
        }
        if (task.due_soon) {
            dueSoon += 1;
        }
        if (task.requires_alarm && task.acknowledgment.active !== true) {
            activeAlarm += 1;
        }
    }
    return {
        total: tasks.length,
        actionable,
        claimed,
        breached,
        due_soon: dueSoon,
        active_alarm: activeAlarm,
        counts_by_category: countsByCategory,
    };
}
function normalizeError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = message.trim();
    if (trimmed.startsWith('ConnectionLostError: ')) {
        return trimmed.slice('ConnectionLostError: '.length);
    }
    return trimmed || 'unexpected_error';
}
function taskRecordBase(input) {
    const breached = input.actionable &&
        input.deadline_at != null &&
        Date.parse(input.deadline_at) < Date.now();
    const dueSoon = input.actionable &&
        input.deadline_at != null &&
        !breached &&
        Date.parse(input.deadline_at) - Date.now() <= 3 * 60 * 1000;
    return {
        task_key: input.task_key,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        category: input.category,
        priority: priorityFor(input.deadline_at),
        title: input.title,
        subtitle: input.subtitle,
        status: input.status,
        target_section: input.target_section,
        actionable: input.actionable,
        created_at: input.created_at,
        deadline_at: input.deadline_at,
        breached_sla: breached,
        due_soon: dueSoon,
        requires_alarm: breached || dueSoon,
        claim: {
            user_id: null,
            name: null,
            at: null,
        },
        acknowledgment: {
            user_id: null,
            name: null,
            at: null,
            until: null,
            active: false,
        },
        record: input.record,
    };
}
function applyTaskState(task, state) {
    if (!state) {
        return task;
    }
    const until = normalizeTimestamp(state.acknowledged_until);
    const ackActive = until != null && Date.parse(until) > Date.now();
    return {
        ...task,
        claim: {
            user_id: normalizeNullableText(state.claimed_by_user_id),
            name: normalizeNullableText(state.claimed_by_name),
            at: normalizeTimestamp(state.claimed_at),
        },
        acknowledgment: {
            user_id: normalizeNullableText(state.acknowledged_by_user_id),
            name: normalizeNullableText(state.acknowledged_by_name),
            at: normalizeTimestamp(state.acknowledged_at),
            until,
            active: ackActive,
        },
    };
}
async function loadAdminSettings(client) {
    const settingsRes = await client.query('SELECT key, value FROM admin_settings');
    const settings = {
        campaign_approval_mode: 'MANUAL',
        operations_sla_minutes: String(DEFAULT_SLA_MINUTES),
        operations_ack_minutes: String(DEFAULT_ACK_MINUTES),
    };
    for (const row of settingsRes.rows) {
        settings[String(row.key)] = String(row.value ?? '');
    }
    return settings;
}
async function loadTaskStates(client, taskKeys) {
    if (taskKeys.length === 0) {
        return [];
    }
    const res = await client.query(`
    SELECT
      s.task_key,
      s.entity_type,
      s.entity_id,
      s.category,
      s.target_section,
      s.claimed_by_user_id::text,
      s.claimed_at,
      COALESCE(claimant.full_name, claimant.email) AS claimed_by_name,
      s.acknowledged_by_user_id::text,
      s.acknowledged_at,
      s.acknowledged_until,
      COALESCE(acknowledger.full_name, acknowledger.email) AS acknowledged_by_name,
      s.resolved_at
    FROM admin_operation_task_states s
    LEFT JOIN users claimant ON claimant.id = s.claimed_by_user_id
    LEFT JOIN users acknowledger ON acknowledger.id = s.acknowledged_by_user_id
    WHERE s.task_key = ANY($1::text[])
      AND s.resolved_at IS NULL
    `, [taskKeys]);
    return res.rows;
}
async function loadApprovalTasks(client, access, slaMinutes) {
    if (!hasAdminModuleAccess(access, ADMIN_MODULE_CAMPAIGNS)) {
        return [];
    }
    const state = { conditions: [`c.approval_status = 'PENDING_APPROVAL'`], params: [], idx: 1 };
    appendScope(state, access, {
        country: 'c.country_id',
        division: 'c.division_id',
    });
    const where = `WHERE ${state.conditions.join(' AND ')}`;
    const res = await client.query(`
    SELECT
      c.id,
      c.title,
      c.approval_deadline,
      c.created_at,
      u.full_name AS business_name,
      u.email AS business_email
    FROM campaigns c
    JOIN users u ON u.id = c.business_id
    ${where}
    ORDER BY c.approval_deadline ASC NULLS LAST, c.created_at ASC
    LIMIT 200
    `, state.params);
    return res.rows.map((row) => {
        const createdAt = normalizeTimestamp(row.created_at);
        const deadlineAt = minTimestamp(normalizeTimestamp(row.approval_deadline), addMinutes(createdAt, slaMinutes));
        return taskRecordBase({
            task_key: `approval:${row.id}`,
            entity_type: 'CAMPAIGN_APPROVAL',
            entity_id: String(row.id),
            category: 'APPROVALS',
            title: normalizeText(row.title, 'Campaign approval pending'),
            subtitle: normalizeText(row.business_name ?? row.business_email, 'Business review'),
            status: 'PENDING',
            target_section: 'approvals',
            actionable: true,
            created_at: createdAt,
            deadline_at: deadlineAt,
            record: row,
        });
    });
}
async function loadCompletionTasks(client, access, slaMinutes) {
    if (!hasAdminModuleAccess(access, ADMIN_MODULE_PROOFS)) {
        return [];
    }
    const state = {
        conditions: [`p.status = 'PENDING'`],
        params: [],
        idx: 1,
    };
    appendScope(state, access, {
        country: 'c.country_id',
        division: 'c.division_id',
    });
    const where = `WHERE ${state.conditions.join(' AND ')}`;
    const res = await client.query(`
    SELECT
      p.id AS proof_id,
      p.status AS proof_status,
      p.created_at AS submitted_at,
      p.updated_at,
      c.id AS campaign_id,
      c.title AS campaign_title,
      ambassador.full_name AS ambassador_name,
      ambassador.email AS ambassador_email
    FROM proofs p
    JOIN verification_sessions vs ON vs.id = p.session_id
    JOIN campaigns c ON c.id = vs.campaign_id
    JOIN users ambassador ON ambassador.id = p.user_id
    ${where}
    ORDER BY p.created_at ASC
    LIMIT 200
    `, state.params);
    return res.rows.map((row) => {
        const createdAt = normalizeTimestamp(row.submitted_at ?? row.updated_at);
        return taskRecordBase({
            task_key: `completion:${row.proof_id}`,
            entity_type: 'CAMPAIGN_COMPLETION',
            entity_id: String(row.proof_id),
            category: 'COMPLETIONS',
            title: normalizeText(row.campaign_title, 'Completion review'),
            subtitle: normalizeText(row.ambassador_name ?? row.ambassador_email, 'Ambassador proof'),
            status: normalizeText(row.proof_status, 'PENDING'),
            target_section: 'completions',
            actionable: true,
            created_at: createdAt,
            deadline_at: addMinutes(createdAt, slaMinutes),
            record: row,
        });
    });
}
async function loadVerificationTasks(client, access, slaMinutes) {
    if (!hasAdminModuleAccess(access, ADMIN_MODULE_PROOFS)) {
        return [];
    }
    const state = {
        conditions: [`pvr.status = 'PENDING'`],
        params: [],
        idx: 1,
    };
    appendScope(state, access, {
        country: 'u.country_id',
        division: 'u.division_id',
    });
    const where = `WHERE ${state.conditions.join(' AND ')}`;
    const res = await client.query(`
    SELECT
      pvr.id,
      pvr.user_id,
      pvr.status,
      pvr.created_at,
      u.full_name AS user_name,
      u.email AS user_email
    FROM ambassador_verification_recordings pvr
    JOIN users u ON u.id = pvr.user_id
    ${where}
    ORDER BY pvr.created_at ASC
    LIMIT 200
    `, state.params);
    return res.rows.map((row) => {
        const createdAt = normalizeTimestamp(row.created_at);
        return taskRecordBase({
            task_key: `verification:${row.id}`,
            entity_type: 'AMBASSADOR_VERIFICATION',
            entity_id: String(row.id),
            category: 'VERIFICATIONS',
            title: normalizeText(row.user_name, 'Verification review'),
            subtitle: normalizeText(row.user_email, 'Ambassador recording'),
            status: normalizeText(row.status, 'PENDING'),
            target_section: 'verifications',
            actionable: true,
            created_at: createdAt,
            deadline_at: addMinutes(createdAt, slaMinutes),
            record: row,
        });
    });
}
async function loadPayoutTasks(client, access, slaMinutes) {
    if (!hasAdminModuleAccess(access, ADMIN_MODULE_PAYOUT_REQUESTS)) {
        return [];
    }
    const state = {
        conditions: [`p.status IN ('REQUESTED', 'PROCESSING')`],
        params: [],
        idx: 1,
    };
    appendScope(state, access, {
        country: 'u.country_id',
        division: 'u.division_id',
    });
    const where = `WHERE ${state.conditions.join(' AND ')}`;
    const res = await client.query(`
    SELECT
      p.id,
      p.user_id,
      p.amount,
      p.status,
      p.created_at,
      u.full_name,
      u.email
    FROM payout_requests p
    JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY p.created_at ASC
    LIMIT 200
    `, state.params);
    return res.rows.map((row) => {
        const createdAt = normalizeTimestamp(row.created_at);
        const status = normalizeText(row.status, 'REQUESTED');
        const actionable = status === 'REQUESTED';
        return taskRecordBase({
            task_key: `payout:${row.id}`,
            entity_type: 'PAYOUT_REQUEST',
            entity_id: String(row.id),
            category: 'PAYOUTS',
            title: `Payout ${String(row.id).slice(0, 8)}`,
            subtitle: normalizeText(row.full_name ?? row.email, 'Payout queue'),
            status,
            target_section: 'payouts',
            actionable,
            created_at: createdAt,
            deadline_at: actionable ? addMinutes(createdAt, slaMinutes) : null,
            record: row,
        });
    });
}
async function loadJobTasks(client, access, slaMinutes) {
    if (access.admin_role !== 'SUPER_ADMIN' ||
        !hasAdminModuleAccess(access, ADMIN_MODULE_JOBS)) {
        return [];
    }
    const res = await client.query(`
    SELECT id, job_type, status, last_error, created_at, updated_at
    FROM job_queue
    WHERE status IN ('FAILED', 'RETRY')
    ORDER BY updated_at DESC
    LIMIT 200
    `);
    return res.rows.map((row) => {
        const createdAt = normalizeTimestamp(row.updated_at ?? row.created_at);
        return taskRecordBase({
            task_key: `job:${row.id}`,
            entity_type: 'JOB',
            entity_id: String(row.id),
            category: 'JOBS',
            title: normalizeText(row.job_type, 'Worker queue issue'),
            subtitle: normalizeText(row.last_error, 'Retry required'),
            status: normalizeText(row.status, 'FAILED'),
            target_section: 'jobs',
            actionable: true,
            created_at: createdAt,
            deadline_at: addMinutes(createdAt, slaMinutes),
            record: row,
        });
    });
}
async function loadRiskTasks(client, access) {
    if (!hasAdminModuleAccess(access, ADMIN_MODULE_RISK)) {
        return [];
    }
    const trustState = { conditions: [], params: [], idx: 1 };
    appendScope(trustState, access, {
        country: 'u.country_id',
        division: 'u.division_id',
    });
    trustState.conditions.push(`COALESCE(ts.score, 50) < 40`);
    const trustWhere = `WHERE ${trustState.conditions.join(' AND ')}`;
    const trustRes = await client.query(`
    SELECT
      u.id AS user_id,
      u.public_id,
      u.email,
      COALESCE(ts.score, 50)::int AS trust_score,
      latest.created_at AS latest_event_at
    FROM users u
    LEFT JOIN trust_scores ts ON ts.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT created_at
      FROM trust_events te
      WHERE te.user_id = u.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON TRUE
    ${trustWhere}
    ORDER BY COALESCE(latest.created_at, u.created_at) DESC
    LIMIT 80
    `, trustState.params);
    const fingerprintState = { conditions: [], params: [], idx: 1 };
    appendScope(fingerprintState, access, {
        country: 'u.country_id',
        division: 'u.division_id',
    });
    fingerprintState.conditions.push(`COALESCE(collision.user_count, 0) > 1`);
    const fingerprintWhere = `WHERE ${fingerprintState.conditions.join(' AND ')}`;
    const fingerprintRes = await client.query(`
    SELECT
      df.fingerprint_hash,
      df.created_at,
      u.email,
      COALESCE(collision.user_count, 0)::int AS collision_user_count
    FROM device_fingerprints df
    JOIN users u ON u.id = df.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT df2.user_id) AS user_count
      FROM device_fingerprints df2
      WHERE df2.fingerprint_hash = df.fingerprint_hash
    ) collision ON TRUE
    ${fingerprintWhere}
    ORDER BY df.created_at DESC
    LIMIT 80
    `, fingerprintState.params);
    const tasks = trustRes.rows.map((row) => {
        const trustScore = Number(row.trust_score ?? 50);
        return taskRecordBase({
            task_key: `risk:trust:${row.user_id}`,
            entity_type: 'TRUST_SIGNAL',
            entity_id: String(row.user_id),
            category: 'RISK',
            title: normalizeText(row.email, 'Trust anomaly'),
            subtitle: `Trust score ${Number.isFinite(trustScore) ? trustScore : 50}`,
            status: 'WATCH',
            target_section: 'risk',
            actionable: false,
            created_at: normalizeTimestamp(row.latest_event_at),
            deadline_at: null,
            record: row,
        });
    });
    for (const row of fingerprintRes.rows) {
        tasks.push(taskRecordBase({
            task_key: `risk:fingerprint:${row.fingerprint_hash}`,
            entity_type: 'DEVICE_COLLISION',
            entity_id: String(row.fingerprint_hash),
            category: 'RISK',
            title: normalizeText(row.email, 'Device collision'),
            subtitle: `${Number(row.collision_user_count ?? 0)} users share this fingerprint`,
            status: 'COLLISION',
            target_section: 'risk',
            actionable: false,
            created_at: normalizeTimestamp(row.created_at),
            deadline_at: null,
            record: row,
        }));
    }
    return tasks;
}
async function loadNotifications(client, access, limit) {
    const capped = Math.min(Math.max(Math.trunc(limit), 4), 40);
    const userLimit = Math.max(2, Math.ceil(capped / 2));
    const fundingLimit = Math.max(2, capped - userLimit);
    const signupState = { conditions: [], params: [], idx: 1 };
    appendScope(signupState, access, {
        country: 'u.country_id',
        division: 'u.division_id',
    });
    const signupWhere = signupState.conditions.length > 0
        ? `WHERE ${signupState.conditions.join(' AND ')}`
        : '';
    const signupsRes = await client.query(`
    SELECT
      u.id,
      u.public_id,
      COALESCE(u.full_name, u.email) AS display_name,
      u.email,
      u.created_at
    FROM users u
    ${signupWhere}
    ORDER BY u.created_at DESC
    LIMIT $${signupState.idx}
    `, [...signupState.params, userLimit]);
    const fundingState = { conditions: [`e.status IN ('FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED')`], params: [], idx: 1 };
    appendScope(fundingState, access, {
        country: 'c.country_id',
        division: 'c.division_id',
    });
    const fundingWhere = `WHERE ${fundingState.conditions.join(' AND ')}`;
    const fundedRes = await client.query(`
    SELECT
      e.id,
      e.status,
      e.created_at,
      c.id AS campaign_id,
      c.title AS campaign_title,
      COALESCE(business.full_name, business.email) AS business_name
    FROM escrow_ledger e
    JOIN campaigns c ON c.id = e.campaign_id
    JOIN users business ON business.id = c.business_id
    ${fundingWhere}
    ORDER BY e.created_at DESC
    LIMIT $${fundingState.idx}
    `, [...fundingState.params, fundingLimit]);
    const items = [
        ...signupsRes.rows.map((row) => ({
            id: `signup:${row.id}`,
            type: 'USER_JOINED',
            title: 'New user joined',
            body: `${normalizeText(row.display_name, 'A new user')} created an account.`,
            created_at: normalizeTimestamp(row.created_at),
            target_section: 'users',
            priority: 'INFO',
            record: row,
        })),
        ...fundedRes.rows.map((row) => ({
            id: `funded:${row.id}`,
            type: 'ESCROW_FUNDED',
            title: 'Campaign funded',
            body: `${normalizeText(row.business_name, 'A business')} funded "${normalizeText(row.campaign_title, 'a campaign')}".`,
            created_at: normalizeTimestamp(row.created_at),
            target_section: 'contracts',
            priority: 'INFO',
            record: row,
        })),
    ];
    return items
        .sort((left, right) => {
        const leftAt = left.created_at == null ? 0 : Date.parse(String(left.created_at));
        const rightAt = right.created_at == null ? 0 : Date.parse(String(right.created_at));
        return rightAt - leftAt;
    })
        .slice(0, capped);
}
async function loadMessages(client, limit) {
    const capped = Math.min(Math.max(Math.trunc(limit), 10), 100);
    const res = await client.query(`
    SELECT
      m.id,
      m.body,
      m.created_at,
      u.id AS sender_user_id,
      COALESCE(u.full_name, u.email) AS sender_name,
      COALESCE(au.role, 'ADMIN') AS sender_role
    FROM admin_operation_messages m
    JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN admin_users au ON au.user_id = u.id
    ORDER BY m.created_at DESC
    LIMIT $1
    `, [capped]);
    return res.rows;
}
async function loadOperators(client, limit) {
    const capped = Math.min(Math.max(Math.trunc(limit), 10), 100);
    const res = await client.query(`
    SELECT
      u.id,
      COALESCE(u.full_name, u.email) AS full_name,
      u.email,
      au.role,
      au.status AS admin_status,
      au.last_login_at,
      latest_audit.created_at AS last_action_at
    FROM admin_users au
    JOIN users u ON u.id = au.user_id
    LEFT JOIN LATERAL (
      SELECT created_at
      FROM admin_audit_logs audit
      WHERE audit.actor_id = u.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest_audit ON TRUE
    WHERE au.status <> 'DELETED'
    ORDER BY COALESCE(latest_audit.created_at, au.last_login_at, au.created_at) DESC
    LIMIT $1
    `, [capped]);
    return res.rows;
}
async function loadAuditFeed(client, access, limit) {
    const capped = Math.min(Math.max(Math.trunc(limit), 10), 100);
    const state = { conditions: [], params: [], idx: 1 };
    appendScope(state, access, {
        country: 'country_id',
        division: 'division_id',
    });
    const where = state.conditions.length > 0
        ? `WHERE ${state.conditions.join(' AND ')}`
        : '';
    const res = await client.query(`
    SELECT *
    FROM admin_audit_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${state.idx}
    `, [...state.params, capped]);
    return res.rows;
}
async function loadVisibleTasks(client, access, slaMinutes) {
    const groups = await Promise.all([
        loadApprovalTasks(client, access, slaMinutes),
        loadCompletionTasks(client, access, slaMinutes),
        loadVerificationTasks(client, access, slaMinutes),
        loadPayoutTasks(client, access, slaMinutes),
        loadJobTasks(client, access, slaMinutes),
        loadRiskTasks(client, access),
    ]);
    return groups.flat().sort(compareTasks);
}
async function safeLoad(partialErrors, key, loader, fallback) {
    try {
        return await loader();
    }
    catch (error) {
        partialErrors[key] = normalizeError(error);
        return fallback;
    }
}
export async function ensureAdminOperationsSchema(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_operation_task_states (
      task_key TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      category TEXT NOT NULL,
      target_section TEXT NOT NULL,
      claimed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ,
      acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_until TIMESTAMPTZ,
      resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_operation_task_states_entity_idx
    ON admin_operation_task_states (entity_type, entity_id, resolved_at)
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_operation_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_operation_messages_created_idx
    ON admin_operation_messages (created_at DESC)
  `);
}
export async function loadAdminOperationsSnapshot(client, access, options = {}) {
    await ensureAdminOperationsSchema(client);
    const partialErrors = {};
    const settings = await safeLoad(partialErrors, 'settings', () => loadAdminSettings(client), {
        campaign_approval_mode: 'MANUAL',
        operations_sla_minutes: String(DEFAULT_SLA_MINUTES),
        operations_ack_minutes: String(DEFAULT_ACK_MINUTES),
    });
    const slaMinutes = parsePositiveSetting(settings.operations_sla_minutes, DEFAULT_SLA_MINUTES);
    const notificationLimit = options.notificationLimit ?? 12;
    const messageLimit = options.messageLimit ?? 40;
    const operatorLimit = options.operatorLimit ?? 24;
    const auditLimit = options.auditLimit ?? 20;
    const tasks = await safeLoad(partialErrors, 'tasks', () => loadVisibleTasks(client, access, slaMinutes), []);
    const states = await safeLoad(partialErrors, 'task_states', () => loadTaskStates(client, tasks.map((task) => task.task_key)), []);
    const stateByKey = new Map(states.map((row) => [row.task_key, row]));
    const hydratedTasks = tasks
        .map((task) => applyTaskState(task, stateByKey.get(task.task_key)))
        .sort(compareTasks);
    const notifications = await safeLoad(partialErrors, 'notifications', () => loadNotifications(client, access, notificationLimit), []);
    const messages = options.includeMessages === false
        ? []
        : await safeLoad(partialErrors, 'messages', () => loadMessages(client, messageLimit), []);
    const operators = options.includeWorkforce === false
        ? []
        : await safeLoad(partialErrors, 'operators', () => loadOperators(client, operatorLimit), []);
    const auditFeed = options.includeAudit === false ||
        (!hasAdminModuleAccess(access, ADMIN_MODULE_AUDIT_LOGS) &&
            access.admin_role !== 'SUPER_ADMIN')
        ? []
        : await safeLoad(partialErrors, 'audit', () => loadAuditFeed(client, access, auditLimit), []);
    return {
        generated_at: nowIso(),
        settings: {
            ...settings,
            operations_sla_minutes: String(slaMinutes),
            operations_ack_minutes: String(parsePositiveSetting(settings.operations_ack_minutes, DEFAULT_ACK_MINUTES, slaMinutes)),
        },
        partial_errors: partialErrors,
        task_summary: summarizeTasks(hydratedTasks),
        tasks: hydratedTasks,
        notifications,
        messages,
        operators,
        audit_feed: auditFeed,
    };
}
export async function loadVisibleAdminOperationTask(client, access, taskKey) {
    const settings = await loadAdminSettings(client);
    const slaMinutes = parsePositiveSetting(settings.operations_sla_minutes, DEFAULT_SLA_MINUTES);
    const tasks = await loadVisibleTasks(client, access, slaMinutes);
    return tasks.find((task) => task.task_key === taskKey) ?? null;
}
export async function claimAdminOperationTask(client, actorUserId, task, ackMinutes) {
    await ensureAdminOperationsSchema(client);
    const res = await client.query(`
    INSERT INTO admin_operation_task_states (
      task_key,
      entity_type,
      entity_id,
      category,
      target_section,
      claimed_by_user_id,
      claimed_at,
      acknowledged_by_user_id,
      acknowledged_at,
      acknowledged_until,
      resolved_by_user_id,
      resolved_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6::uuid, NOW(),
      $6::uuid, NOW(), NOW() + ($7::int * INTERVAL '1 minute'),
      NULL, NULL, NOW()
    )
    ON CONFLICT (task_key)
    DO UPDATE SET
      entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id,
      category = EXCLUDED.category,
      target_section = EXCLUDED.target_section,
      claimed_by_user_id = EXCLUDED.claimed_by_user_id,
      claimed_at = NOW(),
      acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
      acknowledged_at = NOW(),
      acknowledged_until = EXCLUDED.acknowledged_until,
      resolved_by_user_id = NULL,
      resolved_at = NULL,
      updated_at = NOW()
    RETURNING task_key
    `, [
        task.task_key,
        task.entity_type,
        task.entity_id,
        task.category,
        task.target_section,
        actorUserId,
        ackMinutes,
    ]);
    return res.rows[0] ?? null;
}
export async function acknowledgeAdminOperationTask(client, actorUserId, task, ackMinutes) {
    await ensureAdminOperationsSchema(client);
    const res = await client.query(`
    INSERT INTO admin_operation_task_states (
      task_key,
      entity_type,
      entity_id,
      category,
      target_section,
      acknowledged_by_user_id,
      acknowledged_at,
      acknowledged_until,
      resolved_by_user_id,
      resolved_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6::uuid, NOW(), NOW() + ($7::int * INTERVAL '1 minute'),
      NULL, NULL, NOW()
    )
    ON CONFLICT (task_key)
    DO UPDATE SET
      entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id,
      category = EXCLUDED.category,
      target_section = EXCLUDED.target_section,
      acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
      acknowledged_at = NOW(),
      acknowledged_until = EXCLUDED.acknowledged_until,
      resolved_by_user_id = NULL,
      resolved_at = NULL,
      updated_at = NOW()
    RETURNING task_key
    `, [
        task.task_key,
        task.entity_type,
        task.entity_id,
        task.category,
        task.target_section,
        actorUserId,
        ackMinutes,
    ]);
    return res.rows[0] ?? null;
}
export async function loadAdminOperationTaskState(client, taskKey) {
    const rows = await loadTaskStates(client, [taskKey]);
    return rows[0] ?? null;
}
export async function releaseAdminOperationTaskClaim(client, taskKey) {
    await ensureAdminOperationsSchema(client);
    const res = await client.query(`
    UPDATE admin_operation_task_states
    SET claimed_by_user_id = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE task_key = $1
      AND resolved_at IS NULL
    RETURNING task_key
    `, [taskKey]);
    return res.rows[0] ?? null;
}
export async function resolveAdminOperationTaskByEntity(client, entityType, entityId, actorUserId) {
    await ensureAdminOperationsSchema(client);
    await client.query(`
    UPDATE admin_operation_task_states
    SET resolved_by_user_id = COALESCE($3::uuid, resolved_by_user_id),
        resolved_at = NOW(),
        updated_at = NOW()
    WHERE entity_type = $1
      AND entity_id = $2
      AND resolved_at IS NULL
    `, [entityType, entityId, actorUserId ?? null]);
}
export async function createAdminOperationMessage(client, senderUserId, body) {
    await ensureAdminOperationsSchema(client);
    const normalizedBody = normalizeText(body).slice(0, MAX_MESSAGE_LENGTH);
    const res = await client.query(`
    INSERT INTO admin_operation_messages (sender_user_id, body)
    VALUES ($1::uuid, $2)
    RETURNING id, created_at
    `, [senderUserId, normalizedBody]);
    return res.rows[0] ?? null;
}

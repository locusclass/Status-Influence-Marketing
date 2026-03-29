function toRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return { ...value };
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}
function readBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(normalized)) {
            return true;
        }
        if (['false', '0', 'no', 'n'].includes(normalized)) {
            return false;
        }
    }
    return null;
}
function readString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
export function normalizeCampaignPlatform(value) {
    const platform = String(value ?? '').trim().toUpperCase();
    if (platform === 'TIKTOK' || platform === 'X') {
        return platform;
    }
    return 'WHATSAPP_STATUS';
}
export function isCreatorPlatform(value) {
    return normalizeCampaignPlatform(value) !== 'WHATSAPP_STATUS';
}
export function resolveDeliveryModel(platform, requested) {
    if (normalizeCampaignPlatform(platform) === 'TIKTOK') {
        return 'PROBABILISTIC';
    }
    return String(requested ?? '').trim().toUpperCase() === 'PROBABILISTIC'
        ? 'PROBABILISTIC'
        : 'DETERMINISTIC';
}
export function getPublicContractUnitRate(mediaType) {
    const normalized = String(mediaType ?? '').trim().toUpperCase();
    return normalized === 'VIDEO' ? 200 : 100;
}
export function normalizeExecutionMeta(platform, rawMeta) {
    const source = toRecord(rawMeta);
    const normalized = {};
    for (const [key, value] of Object.entries(source)) {
        if (value != null) {
            normalized[key] = value;
        }
    }
    normalized.delivery_model = resolveDeliveryModel(platform, source.delivery_model);
    const creatorScoreFloor = readNumber(source.creator_score_floor);
    if (creatorScoreFloor != null) {
        normalized.creator_score_floor = Math.max(0, Math.min(100, Math.round(creatorScoreFloor)));
    }
    const engagementThreshold = readNumber(source.min_engagement_rate ?? source.engagement_threshold);
    if (engagementThreshold != null) {
        normalized.min_engagement_rate = Math.max(0, engagementThreshold);
    }
    const burstMode = readBoolean(source.burst_mode);
    if (burstMode != null) {
        normalized.burst_mode = burstMode;
    }
    const burstWindowMinutes = readNumber(source.burst_window_minutes);
    if (burstWindowMinutes != null) {
        normalized.burst_window_minutes = Math.max(1, Math.round(burstWindowMinutes));
    }
    const xActionType = readString(source.x_action_type ?? source.action_type);
    if (xActionType) {
        normalized.x_action_type = xActionType.toUpperCase();
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}
export function getExecutionMeta(campaign) {
    return toRecord(campaign?.execution_meta);
}
export function getCreatorScoreFloor(campaign) {
    return Math.max(0, Math.round(readNumber(getExecutionMeta(campaign).creator_score_floor) ?? 0));
}
export function getMinEngagementRate(campaign) {
    return Math.max(0, readNumber(getExecutionMeta(campaign).min_engagement_rate) ?? 0);
}
export function getCampaignBurstMode(campaign) {
    const explicitColumn = readBoolean(campaign?.campaign_burst_mode);
    if (explicitColumn != null) {
        return explicitColumn;
    }
    return readBoolean(getExecutionMeta(campaign).burst_mode) ?? false;
}
export function getBurstWindowMinutes(campaign) {
    const value = readNumber(getExecutionMeta(campaign).burst_window_minutes);
    if (value == null) {
        return null;
    }
    return Math.max(1, Math.round(value));
}
export function getRequiredLiveHours(campaign) {
    return Math.max(1, Math.round(readNumber(campaign?.terms_keep_hours) ?? 12));
}
export function getPrimaryMetricTarget(campaign) {
    const platform = normalizeCampaignPlatform(campaign?.platform);
    if (platform === 'X') {
        return Math.max(0, Math.round(readNumber(campaign?.impression_target) ??
            readNumber(campaign?.terms_min_views) ??
            0));
    }
    return Math.max(0, Math.round(readNumber(campaign?.terms_min_views) ??
        readNumber(campaign?.impression_target) ??
        0));
}
export function extractSubmissionData(meta) {
    return toRecord(meta?.submission);
}
export function extractMetricsSnapshot(meta) {
    const direct = toRecord(meta?.metrics_snapshot);
    if (Object.keys(direct).length > 0) {
        return direct;
    }
    const submission = extractSubmissionData(meta);
    return toRecord(submission.metrics_snapshot);
}
export function deriveEngagementRate(snapshot) {
    const metrics = toRecord(snapshot);
    const explicit = readNumber(metrics.engagement_rate);
    if (explicit != null) {
        return Math.max(0, explicit);
    }
    const likes = Math.max(0, readNumber(metrics.likes) ?? 0);
    const comments = Math.max(0, readNumber(metrics.comments) ?? 0);
    const shares = Math.max(0, readNumber(metrics.shares) ?? 0);
    const denominator = Math.max(0, readNumber(metrics.views) ?? readNumber(metrics.impressions) ?? 0);
    if (denominator <= 0) {
        return 0;
    }
    return Number(((((likes + comments + shares) / denominator) * 100) || 0).toFixed(4));
}
export function getSubmissionPrimaryMetric(campaign, meta, fallbackMetric) {
    const platform = normalizeCampaignPlatform(campaign?.platform);
    const metrics = extractMetricsSnapshot(meta);
    const fallback = Math.max(0, Math.round(readNumber(fallbackMetric) ?? 0));
    if (platform === 'X') {
        return Math.max(0, Math.round(readNumber(metrics.impressions) ??
            readNumber(metrics.views) ??
            fallback));
    }
    return Math.max(0, Math.round(readNumber(metrics.views) ?? readNumber(metrics.impressions) ?? fallback));
}
export function getSubmissionPostId(meta) {
    const submission = extractSubmissionData(meta);
    return readString(submission.post_id);
}
export function getSubmissionPostUrl(meta) {
    const submission = extractSubmissionData(meta);
    return readString(submission.post_url ?? submission.video_url);
}
export function getSubmissionVideoUrl(meta) {
    const submission = extractSubmissionData(meta);
    return readString(submission.video_url);
}
export function isSubmissionPublic(meta) {
    const submission = extractSubmissionData(meta);
    const metrics = extractMetricsSnapshot(meta);
    return (readBoolean(submission.post_is_public ?? metrics.post_is_public) ?? true);
}
export function doesSubmissionExist(meta) {
    const submission = extractSubmissionData(meta);
    const metrics = extractMetricsSnapshot(meta);
    return (readBoolean(submission.post_exists ??
        submission.video_exists ??
        metrics.post_exists ??
        metrics.video_exists) ?? true);
}
export function getSubmissionLiveHours(meta) {
    const submission = extractSubmissionData(meta);
    const metrics = extractMetricsSnapshot(meta);
    return Math.max(0, readNumber(submission.live_hours ?? metrics.live_hours) ?? 0);
}
export function getSubmissionActionType(meta) {
    const submission = extractSubmissionData(meta);
    return readString(submission.action_type);
}

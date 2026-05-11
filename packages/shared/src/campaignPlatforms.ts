export type CampaignPlatform = 'WHATSAPP_STATUS';
export type DeliveryModel = 'DETERMINISTIC' | 'PROBABILISTIC';

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as JsonRecord) };
}

function readNumber(value: unknown): number | null {
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

function readBoolean(value: unknown): boolean | null {
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

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCampaignPlatform(value: unknown): CampaignPlatform {
  return 'WHATSAPP_STATUS';
}

export function isCreatorPlatform(value: unknown): boolean {
  return false;
}

export function resolveDeliveryModel(
  platform: unknown,
  requested?: unknown
): DeliveryModel {
  return 'DETERMINISTIC';
}

export function getPublicContractUnitRate(mediaType: unknown): number {
  const normalized = String(mediaType ?? '').trim().toUpperCase();
  return normalized === 'VIDEO' ? 200 : 100;
}

export function normalizeExecutionMeta(
  platform: unknown,
  rawMeta: unknown
): JsonRecord | null {
  const source = toRecord(rawMeta);
  const normalized: JsonRecord = {};

  for (const [key, value] of Object.entries(source)) {
    if (value != null) {
      normalized[key] = value;
    }
  }

  normalized.delivery_model = resolveDeliveryModel(
    platform,
    source.delivery_model
  );

  const creatorScoreFloor = readNumber(source.creator_score_floor);
  if (creatorScoreFloor != null) {
    normalized.creator_score_floor = Math.max(
      0,
      Math.min(100, Math.round(creatorScoreFloor))
    );
  }

  const engagementThreshold = readNumber(
    source.min_engagement_rate ?? source.engagement_threshold
  );
  if (engagementThreshold != null) {
    normalized.min_engagement_rate = Math.max(0, engagementThreshold);
  }

  const burstMode = readBoolean(source.burst_mode);
  if (burstMode != null) {
    normalized.burst_mode = burstMode;
  }

  const burstWindowMinutes = readNumber(source.burst_window_minutes);
  if (burstWindowMinutes != null) {
    normalized.burst_window_minutes = Math.max(
      1,
      Math.round(burstWindowMinutes)
    );
  }

  const xActionType = readString(
    source.x_action_type ?? source.action_type
  );
  if (xActionType) {
    normalized.x_action_type = xActionType.toUpperCase();
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function getExecutionMeta(campaign: any): JsonRecord {
  return toRecord(campaign?.execution_meta);
}

export function getCreatorScoreFloor(campaign: any): number {
  return Math.max(
    0,
    Math.round(readNumber(getExecutionMeta(campaign).creator_score_floor) ?? 0)
  );
}

export function getMinEngagementRate(campaign: any): number {
  return Math.max(
    0,
    readNumber(getExecutionMeta(campaign).min_engagement_rate) ?? 0
  );
}

export function getCampaignBurstMode(campaign: any): boolean {
  const explicitColumn = readBoolean(campaign?.campaign_burst_mode);
  if (explicitColumn != null) {
    return explicitColumn;
  }
  return readBoolean(getExecutionMeta(campaign).burst_mode) ?? false;
}

export function getBurstWindowMinutes(campaign: any): number | null {
  const value = readNumber(getExecutionMeta(campaign).burst_window_minutes);
  if (value == null) {
    return null;
  }
  return Math.max(1, Math.round(value));
}

export function getRequiredLiveHours(campaign: any): number {
  return Math.max(1, Math.round(readNumber(campaign?.terms_keep_hours) ?? 12));
}

export function getPrimaryMetricTarget(campaign: any): number {
  return Math.max(
    0,
    Math.round(
      readNumber(campaign?.terms_min_views) ??
        readNumber(campaign?.impression_target) ??
        0
    )
  );
}

export function extractSubmissionData(meta: any): JsonRecord {
  return toRecord(meta?.submission);
}

export function extractMetricsSnapshot(meta: any): JsonRecord {
  const direct = toRecord(meta?.metrics_snapshot);
  if (Object.keys(direct).length > 0) {
    return direct;
  }
  const submission = extractSubmissionData(meta);
  return toRecord(submission.metrics_snapshot);
}

export function deriveEngagementRate(snapshot: unknown): number {
  const metrics = toRecord(snapshot);
  const explicit = readNumber(metrics.engagement_rate);
  if (explicit != null) {
    return Math.max(0, explicit);
  }

  const likes = Math.max(0, readNumber(metrics.likes) ?? 0);
  const comments = Math.max(0, readNumber(metrics.comments) ?? 0);
  const shares = Math.max(0, readNumber(metrics.shares) ?? 0);
  const denominator = Math.max(
    0,
    readNumber(metrics.views) ?? readNumber(metrics.impressions) ?? 0
  );
  if (denominator <= 0) {
    return 0;
  }
  return Number(
    ((((likes + comments + shares) / denominator) * 100) || 0).toFixed(4)
  );
}

export function getSubmissionPrimaryMetric(
  campaign: any,
  meta: any,
  fallbackMetric?: unknown
): number {
  const metrics = extractMetricsSnapshot(meta);
  const fallback = Math.max(0, Math.round(readNumber(fallbackMetric) ?? 0));
  return Math.max(
    0,
    Math.round(
      readNumber(metrics.views) ?? readNumber(metrics.impressions) ?? fallback
    )
  );
}

export function getSubmissionPostId(meta: any): string | null {
  const submission = extractSubmissionData(meta);
  return readString(submission.post_id);
}

export function getSubmissionPostUrl(meta: any): string | null {
  const submission = extractSubmissionData(meta);
  return readString(submission.post_url ?? submission.video_url);
}

export function getSubmissionVideoUrl(meta: any): string | null {
  const submission = extractSubmissionData(meta);
  return readString(submission.video_url);
}

export function isSubmissionPublic(meta: any): boolean {
  const submission = extractSubmissionData(meta);
  const metrics = extractMetricsSnapshot(meta);
  return (
    readBoolean(submission.post_is_public ?? metrics.post_is_public) ?? true
  );
}

export function doesSubmissionExist(meta: any): boolean {
  const submission = extractSubmissionData(meta);
  const metrics = extractMetricsSnapshot(meta);
  return (
    readBoolean(
      submission.post_exists ??
        submission.video_exists ??
        metrics.post_exists ??
        metrics.video_exists
    ) ?? true
  );
}

export function getSubmissionLiveHours(meta: any): number {
  const submission = extractSubmissionData(meta);
  const metrics = extractMetricsSnapshot(meta);
  return Math.max(
    0,
    readNumber(submission.live_hours ?? metrics.live_hours) ?? 0
  );
}

export function getSubmissionActionType(meta: any): string | null {
  const submission = extractSubmissionData(meta);
  return readString(submission.action_type);
}

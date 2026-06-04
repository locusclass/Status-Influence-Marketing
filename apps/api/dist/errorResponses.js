const EXPLICIT_USER_MESSAGES = {
    unauthorized: 'Please sign in to continue.',
    forbidden: 'You do not have permission to do that.',
    admin_suspended: 'This admin account is suspended.',
    account_suspended: 'This account is suspended.',
    account_disabled: 'This account is disabled.',
    policy_acceptance_required: 'You need to accept the required policies before continuing.',
    validation_error: 'Please check the highlighted fields and try again.',
    validation_failed: 'Please check the highlighted fields and try again.',
    invalid_request_body: 'We could not read that request. Please check the information and try again.',
    bad_request: 'We could not process that request. Please check the information and try again.',
    not_found: 'The requested item was not found.',
    internal_server_error: 'Something went wrong. Please try again.',
    request_timeout: 'The request took too long. Please try again.',
    rate_limited: 'Too many requests. Please wait a moment and try again.',
    service_unavailable: 'This service is temporarily unavailable. Please try again later.',
    file_too_large: 'This file is too large. Please upload a smaller file.',
    invalid_mime: 'This file type is not allowed.',
    missing_file: 'Please choose a file and try again.',
    missing_fields: 'Please fill in the required fields and try again.',
    missing_signature: 'This upload link is incomplete. Please request a new one.',
    invalid_signature: 'This upload link is invalid. Please request a new one.',
    signature_expired: 'This upload link has expired. Please request a new one.',
    yo_uganda_not_configured: 'Payments are temporarily unavailable. Please try again later.',
    yo_uganda_initiate_failed: 'We could not start the payment right now. Please try again.',
    yo_uganda_verify_failed: 'We could not confirm the payment right now. Please try again.',
    firebase_storage_not_configured: 'File upload is temporarily unavailable. Please try again later.',
    firebase_access_token_failed: 'File upload is temporarily unavailable. Please try again.',
    firebase_client_init_failed: 'File upload is temporarily unavailable. Please try again.',
    firebase_storage_upload_failed: 'File upload is temporarily unavailable. Please try again.',
    firebase_storage_download_failed: 'File download is temporarily unavailable. Please try again.',
    firebase_storage_delete_failed: 'File deletion is temporarily unavailable. Please try again.',
    authorization_not_supported: 'This payment step is not required.',
    webhook_not_supported: 'This action is not supported on this endpoint.',
    unsupported_platform: 'This platform is not supported.',
    unsupported_payment_method: 'This payment method is not available for this transaction.',
    payment_reference_required: 'A payment reference is required.',
    invalid_payment_reference: 'The payment reference is invalid.',
    campaign_missing_product_listing: 'Create a product listing and attach it to the campaign before continuing.',
    subscription_required: 'Your account is not eligible for this action yet.',
};
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isCodeLike(value) {
    return /^[a-z0-9_:-]+$/i.test(value) && !value.includes(' ');
}
function looksTechnicalText(value) {
    const text = value.trim();
    if (!text)
        return false;
    if (isCodeLike(text)) {
        return /^(?:fst_err_|und_err_|econn|enotfound|ehostunreach|fatal_startup_configuration|pg_|sqlstate_|\d{5}$)/i.test(text);
    }
    return (/\b(?:syntaxerror|typeerror|referenceerror|postgres|sql|query failed|duplicate key|constraint|timeout|timed out|stack|trace|unexpected token|unexpected end of json input|invalid json|request failed|network error|fetch failed|connectionlosterror|fasterxml|firebase_|yo uganda request failed|und_err_|econn|enotfound|ehostunreach|fatal_startup_configuration)\b/i.test(text) ||
        /https?:\/\//i.test(text) ||
        /(?:^|\s)at\s+\S+/m.test(text) ||
        /[A-Z]:\\/.test(text));
}
function toSentence(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return trimmed;
    const normalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}
function humanizeCode(value) {
    return toSentence(value.replace(/[_-]+/g, ' '));
}
function baseCode(value) {
    if (!isCodeLike(value))
        return value.trim();
    return value.split(':')[0].trim().toLowerCase();
}
function classifyTechnicalError(value, statusCode) {
    const text = value.trim().toLowerCase();
    if (text.startsWith('fst_err_') ||
        text.includes('fst_err_ctp_invalid_json_body') ||
        text.includes('unexpected token') ||
        text.includes('unexpected end of json input') ||
        text.includes('invalid json')) {
        return 'invalid_request_body';
    }
    if (text.includes('yo uganda') ||
        text.includes('mobile money') ||
        text.includes('payment')) {
        return statusCode >= 500 ? 'service_unavailable' : 'bad_request';
    }
    if (text.includes('firebase_') || text.includes('upload') || text.includes('download')) {
        return statusCode >= 500 ? 'service_unavailable' : 'bad_request';
    }
    if (statusCode === 401)
        return 'unauthorized';
    if (statusCode === 403)
        return 'forbidden';
    if (statusCode === 404)
        return 'not_found';
    if (statusCode === 408)
        return 'request_timeout';
    if (statusCode === 413)
        return 'file_too_large';
    if (statusCode === 422)
        return 'validation_failed';
    if (statusCode === 429)
        return 'rate_limited';
    if (statusCode >= 500)
        return 'internal_server_error';
    return 'bad_request';
}
export function normalizePublicErrorCode(value, statusCode) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return classifyTechnicalError('', statusCode);
    }
    if (looksTechnicalText(raw)) {
        return classifyTechnicalError(raw, statusCode);
    }
    if (isCodeLike(raw)) {
        return baseCode(raw);
    }
    return raw;
}
function resolveMessageFromCode(code, statusCode) {
    if (!code) {
        return EXPLICIT_USER_MESSAGES.internal_server_error;
    }
    const normalized = baseCode(code);
    if (normalized in EXPLICIT_USER_MESSAGES) {
        return EXPLICIT_USER_MESSAGES[normalized];
    }
    if (normalized.endsWith('_not_found') || normalized === 'not_found') {
        if (normalized === 'not_found') {
            return EXPLICIT_USER_MESSAGES.not_found;
        }
        const subject = normalized
            .slice(0, -'_not_found'.length)
            .replace(/_/g, ' ')
            .trim();
        return toSentence(`${subject} not found`);
    }
    if (normalized.startsWith('missing_')) {
        return toSentence(`${normalized.slice('missing_'.length).replace(/_/g, ' ')} is required`);
    }
    if (normalized.endsWith('_required')) {
        return toSentence(`${normalized.slice(0, -'_required'.length).replace(/_/g, ' ')} is required`);
    }
    if (normalized.startsWith('invalid_')) {
        return toSentence(`The provided ${normalized.slice('invalid_'.length).replace(/_/g, ' ')} is invalid`);
    }
    if (normalized.endsWith('_taken') ||
        normalized.endsWith('_exists') ||
        normalized.startsWith('duplicate_')) {
        return 'That value is already in use.';
    }
    if (normalized.includes('unauthorized')) {
        return EXPLICIT_USER_MESSAGES.unauthorized;
    }
    if (normalized.includes('forbidden')) {
        return EXPLICIT_USER_MESSAGES.forbidden;
    }
    if (normalized.includes('suspended')) {
        return 'This account is suspended.';
    }
    if (normalized.includes('payment') && normalized.includes('failed')) {
        return 'We could not process the payment right now. Please try again.';
    }
    if (normalized.includes('subscription')) {
        return EXPLICIT_USER_MESSAGES.subscription_required;
    }
    if (normalized.includes('upload') || normalized.includes('file')) {
        return 'We could not complete the file request. Please try again.';
    }
    if (statusCode >= 500) {
        return EXPLICIT_USER_MESSAGES.internal_server_error;
    }
    if (!isCodeLike(code) && !looksTechnicalText(code)) {
        return toSentence(code.replace(/_/g, ' '));
    }
    return humanizeCode(normalized);
}
function shouldKeepDetail(code, statusCode, detail) {
    if (detail == null)
        return false;
    if (statusCode >= 500)
        return false;
    if (Array.isArray(detail) || isRecord(detail)) {
        return code === 'validation_error' || code === 'validation_failed';
    }
    if (typeof detail !== 'string')
        return false;
    if (looksTechnicalText(detail))
        return false;
    return detail.trim().length > 0;
}
function shouldKeepDetails(code, statusCode, details) {
    if (details == null)
        return false;
    if (code === 'validation_error' || code === 'validation_failed') {
        return Array.isArray(details) || isRecord(details);
    }
    if (statusCode >= 500)
        return false;
    if (Array.isArray(details) || isRecord(details))
        return true;
    if (typeof details !== 'string')
        return false;
    return !looksTechnicalText(details);
}
export function maskErrorResponsePayload(payload, statusCode) {
    if (statusCode < 400 || !isRecord(payload)) {
        return payload;
    }
    const result = { ...payload };
    const publicError = normalizePublicErrorCode(result.error, statusCode);
    const shouldExposeCode = isCodeLike(publicError);
    const currentMessage = typeof result.message === 'string' && !looksTechnicalText(result.message)
        ? result.message.trim()
        : '';
    const userMessage = currentMessage || resolveMessageFromCode(publicError, statusCode);
    if (shouldExposeCode) {
        result.code = publicError;
    }
    else if ('code' in result) {
        delete result.code;
    }
    result.error = userMessage;
    result.message = userMessage;
    if ('detail' in result && !shouldKeepDetail(publicError, statusCode, result.detail)) {
        delete result.detail;
    }
    if ('details' in result && !shouldKeepDetails(publicError, statusCode, result.details)) {
        delete result.details;
    }
    return result;
}

export const DEFAULT_YO_GATEWAY_BASE_URL = 'http://34.79.189.141:3000/yo';
export const DEFAULT_YO_GATEWAY_TASK_URL = `${DEFAULT_YO_GATEWAY_BASE_URL}/ybs/task.php`;
const YO_TASK_PATH = '/ybs/task.php';
const DIRECT_YO_HOSTS = new Set([
    'paymentsapi1.yo.co.ug',
    'paymentsapi2.yo.co.ug',
]);
function isTruthyEnv(value) {
    return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
function isDirectYoHost(hostname) {
    return DIRECT_YO_HOSTS.has(hostname.trim().toLowerCase());
}
function normalizeYoTaskPath(pathname) {
    let normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    normalized = normalized.replace(/(?:\/ybs\/task\.php)+$/i, '');
    normalized = normalized.replace(/(?:\/yo)+$/i, '/yo');
    if (!normalized) {
        return YO_TASK_PATH;
    }
    if (/\/ybs$/i.test(normalized)) {
        return `${normalized}/task.php`;
    }
    if (/\/task\.php$/i.test(normalized)) {
        return normalized;
    }
    return `${normalized}${YO_TASK_PATH}`;
}
export function normalizeYoTaskUrl(configuredValue, fallback = DEFAULT_YO_GATEWAY_TASK_URL, options) {
    const configured = String(configuredValue ?? '').trim();
    const allowDirectHostBypass = options?.allowDirectHostBypass ?? false;
    if (!configured) {
        return fallback;
    }
    try {
        const parsed = new URL(configured);
        if (!allowDirectHostBypass && isDirectYoHost(parsed.hostname)) {
            return fallback;
        }
        parsed.pathname = normalizeYoTaskPath(parsed.pathname);
        return parsed.toString();
    }
    catch {
        if (!allowDirectHostBypass &&
            /paymentsapi[12]\.yo\.co\.ug/i.test(configured)) {
            return fallback;
        }
        return normalizeYoTaskPath(configured);
    }
}
export function allowDirectYoHostBypass(value) {
    return isTruthyEnv(value);
}

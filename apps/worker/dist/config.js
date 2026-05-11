import { allowDirectYoHostBypass, collectDirectYoTaskUrls, DEFAULT_YO_GATEWAY_TASK_URL, normalizeYoTaskUrl, } from '@prime/shared';
function stripWrappingQuotes(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
const allowDirectApiBypass = allowDirectYoHostBypass(process.env.YO_ALLOW_DIRECT_API_BYPASS);
const yoConfig = {
    allowDirectApiBypass,
    baseUrl: normalizeYoTaskUrl(stripWrappingQuotes(process.env.YO_BASE_URL ??
        process.env.YO_API_URL ??
        process.env.FLUTTERWAVE_BASE_URL ??
        ''), DEFAULT_YO_GATEWAY_TASK_URL, { allowDirectHostBypass: allowDirectApiBypass }),
    directFailoverBaseUrls: collectDirectYoTaskUrls([
        stripWrappingQuotes(process.env.YO_API_URL_FALLBACK ?? ''),
        stripWrappingQuotes(process.env.YO_FALLBACK_BASE_URL ?? ''),
        stripWrappingQuotes(process.env.YO_API_URL ?? ''),
    ]),
    apiUsername: stripWrappingQuotes(process.env.YO_API_USERNAME ??
        process.env.YO_USERNAME ??
        process.env.FLUTTERWAVE_CLIENT_ID ??
        ''),
    apiPassword: stripWrappingQuotes(process.env.YO_API_PASSWORD ??
        process.env.YO_PASSWORD ??
        process.env.FLUTTERWAVE_CLIENT_SECRET ??
        ''),
    authorizationCode: stripWrappingQuotes(process.env.YO_AUTHORIZATION ??
        process.env.YO_ACCOUNT_AUTHORIZATION ??
        process.env.YO_PROXY_AUTHORIZATION ??
        ''),
    webhookSecretHash: stripWrappingQuotes(process.env.YO_WEBHOOK_SECRET_HASH ??
        process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ??
        ''),
};
export const config = {
    port: parseInt(process.env.PORT ?? '3001', 10),
    databaseUrl: process.env.DATABASE_URL ?? '',
    fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
    yo: yoConfig,
    flutterwave: {
        baseUrl: yoConfig.baseUrl,
        secretKey: '',
        publicKey: '',
        webhookSecretHash: yoConfig.webhookSecretHash,
    },
    pesapal: yoConfig,
};
export function resolveYoBaseUrl() {
    return config.yo.baseUrl;
}
export function resolveYoDirectFailoverBaseUrls() {
    return config.yo.directFailoverBaseUrls;
}

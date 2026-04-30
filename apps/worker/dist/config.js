import { allowDirectYoHostBypass, DEFAULT_YO_GATEWAY_TASK_URL, normalizeYoTaskUrl, } from '@prime/shared';
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
    apiUsername: stripWrappingQuotes(process.env.YO_API_USERNAME ??
        process.env.YO_USERNAME ??
        process.env.FLUTTERWAVE_CLIENT_ID ??
        ''),
    apiPassword: stripWrappingQuotes(process.env.YO_API_PASSWORD ??
        process.env.YO_PASSWORD ??
        process.env.FLUTTERWAVE_CLIENT_SECRET ??
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

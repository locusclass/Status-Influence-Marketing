import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { allowDirectYoHostBypass, DEFAULT_YO_GATEWAY_TASK_URL, normalizeYoTaskUrl, } from '@prime/shared';
function stripWrappingQuotes(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function resolveUploadDir() {
    const explicit = process.env.UPLOAD_DIR?.trim();
    if (explicit) {
        return explicit;
    }
    const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
    if (railwayMount) {
        return path.join(railwayMount, 'uploads');
    }
    const commonPersistentDirs = ['/data/uploads', '/mnt/data/uploads'];
    for (const candidate of commonPersistentDirs) {
        try {
            const parent = path.dirname(candidate);
            if (fs.existsSync(parent)) {
                return candidate;
            }
        }
        catch {
            // Ignore fs detection failures and fall through to the local default.
        }
    }
    return './uploads';
}
const allowDirectApiBypass = allowDirectYoHostBypass(process.env.YO_ALLOW_DIRECT_API_BYPASS);
const yoConfig = {
    allowDirectApiBypass,
    baseUrl: normalizeYoTaskUrl(stripWrappingQuotes(process.env.YO_BASE_URL ??
        process.env.YO_API_URL ??
        process.env.FLUTTERWAVE_BASE_URL ??
        ''), DEFAULT_YO_GATEWAY_TASK_URL, { allowDirectHostBypass: allowDirectApiBypass }),
    fallbackBaseUrl: normalizeYoTaskUrl(stripWrappingQuotes(process.env.YO_API_URL_FALLBACK ??
        process.env.YO_FALLBACK_BASE_URL ??
        process.env.YO_BASE_URL ??
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
const legacyFlutterwaveCompatConfig = {
    baseUrl: yoConfig.baseUrl,
    secretKey: '',
    clientId: yoConfig.apiUsername,
    clientSecret: yoConfig.apiPassword,
    encryptionKey: '',
    publicKey: '',
    webhookSecretHash: yoConfig.webhookSecretHash,
};
export const config = {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? '',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
    corsOrigin: process.env.CORS_ORIGIN ?? '',
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    uploadDir: resolveUploadDir(),
    uploadSigningSecret: process.env.UPLOAD_SIGNING_SECRET ?? 'dev-upload-secret',
    fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
    yo: yoConfig,
    flutterwave: legacyFlutterwaveCompatConfig,
    pesapal: yoConfig,
    adminAccessPhrase: process.env.ADMIN_ACCESS_PHRASE ?? '',
    whatsappVerification: {
        mode: process.env.WHATSAPP_VERIFICATION_MODE ??
            (process.env.NODE_ENV === 'test' ? 'mock' : 'baileys'),
        baileysAuthDir: process.env.WHATSAPP_BAILEYS_AUTH_DIR ?? '.baileys_auth_state',
        mockAllowedPrefixes: process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+',
    },
    firebase: {
        projectId: process.env.FIREBASE_PROJECT_ID ?? '',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
    },
};
export function getStartupConfigIssues() {
    const issues = [];
    if (!config.databaseUrl.trim()) {
        issues.push('DATABASE_URL is missing');
    }
    if (!process.env.PORT?.toString().trim()) {
        issues.push('PORT is not set by the platform, defaulting to 3000');
    }
    if (!config.jwtSecret.trim() || config.jwtSecret === 'dev-secret') {
        issues.push('JWT_SECRET is missing or using the development default');
    }
    if (!config.yo.apiUsername.trim()) {
        issues.push('YO_API_USERNAME is missing');
    }
    if (!config.yo.apiPassword.trim()) {
        issues.push('YO_API_PASSWORD is missing');
    }
    if (config.yo.allowDirectApiBypass) {
        issues.push('YO_ALLOW_DIRECT_API_BYPASS is enabled, so direct YO hosts can bypass the static-IP gateway');
    }
    if (config.firebase.projectId ||
        config.firebase.clientEmail ||
        config.firebase.privateKey ||
        config.firebase.storageBucket) {
        if (!config.firebase.projectId.trim()) {
            issues.push('FIREBASE_PROJECT_ID is missing');
        }
        if (!config.firebase.clientEmail.trim()) {
            issues.push('FIREBASE_CLIENT_EMAIL is missing');
        }
        if (!config.firebase.privateKey.trim()) {
            issues.push('FIREBASE_PRIVATE_KEY is missing');
        }
        if (!config.firebase.storageBucket.trim()) {
            issues.push('FIREBASE_STORAGE_BUCKET is missing');
        }
    }
    return issues;
}
export function isFatalStartupIssue(issue) {
    return (issue.includes('DATABASE_URL is missing') ||
        issue.includes('JWT_SECRET is missing') ||
        issue.includes('JWT_SECRET is missing or using the development default') ||
        issue.includes('FIREBASE_PROJECT_ID is missing') ||
        issue.includes('FIREBASE_CLIENT_EMAIL is missing') ||
        issue.includes('FIREBASE_PRIVATE_KEY is missing') ||
        issue.includes('FIREBASE_STORAGE_BUCKET is missing'));
}
export function hasYoCredentials() {
    return (config.yo.apiUsername.trim().length > 0 &&
        config.yo.apiPassword.trim().length > 0);
}
export function hasValidYoKeys() {
    return hasYoCredentials();
}
export function hasYoClientCredentials() {
    return hasYoCredentials();
}
export function hasYoSecretKey() {
    return false;
}
export function hasYoEncryptionKey() {
    return false;
}
export function resolveYoBaseUrl() {
    return config.yo.baseUrl;
}
export function resolveYoFallbackBaseUrl() {
    return config.yo.fallbackBaseUrl;
}
export const hasValidFlutterwaveKeys = hasValidYoKeys;
export const hasFlutterwaveClientCredentials = hasYoClientCredentials;
export const hasFlutterwaveSecretKey = hasYoSecretKey;
export const hasFlutterwaveEncryptionKey = hasYoEncryptionKey;
export const resolveFlutterwaveBaseUrl = resolveYoBaseUrl;

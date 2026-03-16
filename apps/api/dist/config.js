import 'dotenv/config';
import fs from 'fs';
import path from 'path';
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
const flutterwaveConfig = {
    baseUrl: process.env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com/v3',
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? '',
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
    webhookSecretHash: process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? '',
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
    flutterwave: flutterwaveConfig,
    pesapal: flutterwaveConfig,
    adminAccessPhrase: process.env.ADMIN_ACCESS_PHRASE ?? '',
    whatsappVerification: {
        mode: process.env.WHATSAPP_VERIFICATION_MODE ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'baileys'),
        baileysAuthDir: process.env.WHATSAPP_BAILEYS_AUTH_DIR ?? '.baileys_auth_state',
        mockAllowedPrefixes: process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+',
    },
    firebase: {
        projectId: process.env.FIREBASE_PROJECT_ID ?? '',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
    }
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

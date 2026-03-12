import fs from 'fs';
import path from 'path';
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
export const config = {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? '',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    uploadDir: resolveUploadDir(),
    uploadSigningSecret: process.env.UPLOAD_SIGNING_SECRET ?? 'dev-upload-secret',
    fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
    pesapal: {
        env: process.env.PESAPAL_ENVIRONMENT ?? process.env.PESAPAL_ENV ?? 'sandbox',
        baseUrl: process.env.PESAPAL_BASE_URL ??
            ((process.env.PESAPAL_ENVIRONMENT ?? process.env.PESAPAL_ENV ?? 'sandbox') === 'live'
                ? 'https://pay.pesapal.com/v3'
                : 'https://cybqa.pesapal.com/pesapalv3'),
        consumerKey: process.env.PESAPAL_CONSUMER_KEY ?? '',
        consumerSecret: process.env.PESAPAL_CONSUMER_SECRET ?? '',
        ipnId: process.env.PESAPAL_IPN_ID ?? '',
        callbackUrl: process.env.PESAPAL_CALLBACK_URL ?? '',
        payoutCallbackUrl: process.env.PESAPAL_PAYOUT_CALLBACK_URL ?? '',
        payoutWebhookSecret: process.env.PESAPAL_PAYOUT_WEBHOOK_SECRET ?? '',
        ipnWebhookSecret: process.env.PESAPAL_IPN_WEBHOOK_SECRET ?? ''
    },
    adminAccessPhrase: process.env.ADMIN_ACCESS_PHRASE ?? '',
    whatsappVerification: {
        mode: process.env.WHATSAPP_VERIFICATION_MODE ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'baileys'),
        baileysAuthDir: process.env.WHATSAPP_BAILEYS_AUTH_DIR ?? '.baileys_auth_state',
        mockAllowedPrefixes: process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+',
    },
    firebase: {
        projectId: process.env.FIREBASE_PROJECT_ID ?? '',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
    }
};

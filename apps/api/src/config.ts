import 'dotenv/config';
import fs from 'fs';
import path from 'path';

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
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
    } catch {
      // Ignore fs detection failures and fall through to the local default.
    }
  }

  return './uploads';
}

const flutterwaveConfig = {
  baseUrl: stripWrappingQuotes(process.env.FLUTTERWAVE_BASE_URL ?? ''),
  secretKey: stripWrappingQuotes(process.env.FLUTTERWAVE_SECRET_KEY ?? ''),
  clientId: stripWrappingQuotes(process.env.FLUTTERWAVE_CLIENT_ID ?? ''),
  clientSecret: stripWrappingQuotes(process.env.FLUTTERWAVE_CLIENT_SECRET ?? ''),
  encryptionKey: stripWrappingQuotes(process.env.FLUTTERWAVE_ENCRYPTION_KEY ?? ''),
  publicKey: stripWrappingQuotes(process.env.FLUTTERWAVE_PUBLIC_KEY ?? ''),
  webhookSecretHash: stripWrappingQuotes(process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? ''),
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
  const issues: string[] = [];

  if (!config.databaseUrl.trim()) {
    issues.push('DATABASE_URL is missing');
  }

  if (!process.env.PORT?.toString().trim()) {
    issues.push('PORT is not set by the platform, defaulting to 3000');
  }

  if (!config.jwtSecret.trim() || config.jwtSecret === 'dev-secret') {
    issues.push('JWT_SECRET is missing or using the development default');
  }

  if (config.flutterwave.secretKey && !config.flutterwave.secretKey.trim()) {
    issues.push('FLUTTERWAVE_SECRET_KEY is empty');
  }
  if (config.flutterwave.clientId && !config.flutterwave.clientId.trim()) {
    issues.push('FLUTTERWAVE_CLIENT_ID is empty');
  }
  if (config.flutterwave.clientSecret && !config.flutterwave.clientSecret.trim()) {
    issues.push('FLUTTERWAVE_CLIENT_SECRET is empty');
  }
  if (
    hasFlutterwaveClientCredentials() &&
    !hasFlutterwaveEncryptionKey()
  ) {
    issues.push('FLUTTERWAVE_ENCRYPTION_KEY is missing; card payments are disabled');
  }

  if (
    config.firebase.projectId ||
    config.firebase.clientEmail ||
    config.firebase.privateKey ||
    config.firebase.storageBucket
  ) {
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

export function isFatalStartupIssue(issue: string) {
  return (
    issue.includes('DATABASE_URL is missing') ||
    issue.includes('JWT_SECRET is missing') ||
    issue.includes('JWT_SECRET is missing or using the development default') ||
    issue.includes('FIREBASE_PROJECT_ID is missing') ||
    issue.includes('FIREBASE_CLIENT_EMAIL is missing') ||
    issue.includes('FIREBASE_PRIVATE_KEY is missing') ||
    issue.includes('FIREBASE_STORAGE_BUCKET is missing')
  );
}

export function hasValidFlutterwaveKeys() {
  return hasFlutterwaveSecretKey() || hasFlutterwaveClientCredentials();
}

export function hasFlutterwaveSecretKey() {
  return config.flutterwave.secretKey.trim().length > 0;
}

export function hasFlutterwaveClientCredentials() {
  return (
    config.flutterwave.clientId.trim().length > 0 &&
    config.flutterwave.clientSecret.trim().length > 0
  );
}

export function hasFlutterwaveEncryptionKey() {
  return config.flutterwave.encryptionKey.trim().length > 0;
}

export function resolveFlutterwaveBaseUrl() {
  const configured = config.flutterwave.baseUrl.trim().replace(/\/+$/, '');
  const hasSecret = hasFlutterwaveSecretKey();
  const hasClientCreds = hasFlutterwaveClientCredentials();

  if (configured) {
    if (hasSecret) {
      if (/developersandbox-api\.flutterwave\.com/i.test(configured)) {
        return 'https://ravesandboxapi.flutterwave.com/v3';
      }
      if (/^https:\/\/ravesandboxapi\.flutterwave\.com$/i.test(configured)) {
        return 'https://ravesandboxapi.flutterwave.com/v3';
      }
      if (/^https:\/\/api\.flutterwave\.com$/i.test(configured)) {
        return 'https://api.flutterwave.com/v3';
      }
    }

    if (hasClientCreds) {
      if (/ravesandboxapi\.flutterwave\.com/i.test(configured)) {
        return 'https://developersandbox-api.flutterwave.com';
      }
      if (/api\.flutterwave\.com\/v3$/i.test(configured)) {
        return 'https://f4bexperience.flutterwave.com';
      }
    }

    return configured;
  }

  return hasClientCreds
    ? 'https://developersandbox-api.flutterwave.com'
    : 'https://api.flutterwave.com/v3';
}


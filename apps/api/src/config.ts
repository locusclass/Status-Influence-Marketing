import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  allowDirectYoHostBypass,
  collectDirectYoTaskUrls,
  DEFAULT_YO_GATEWAY_TASK_URL,
  normalizeYoTaskUrl,
} from '@prime/shared';

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

const allowDirectApiBypass = allowDirectYoHostBypass(
  process.env.YO_ALLOW_DIRECT_API_BYPASS
);

export const YO_PROXY_URL_MISSING_MESSAGE = 'YO_PROXY_URL is missing';
export const YO_API_USERNAME_MISSING_MESSAGE = 'YO_API_USERNAME is missing';
export const YO_API_PASSWORD_MISSING_MESSAGE = 'YO_API_PASSWORD is missing';
export const AT_USERNAME_MISSING_MESSAGE = 'AT_USERNAME is missing';
export const AT_API_KEY_MISSING_MESSAGE = 'AT_API_KEY is missing';

const configuredYoApiPassword = stripWrappingQuotes(
  process.env.YO_API_PASSWORD ??
    process.env.YO_PASSWORD ??
    process.env.FLUTTERWAVE_CLIENT_SECRET ??
    ''
);

const configuredYoAuthorization = stripWrappingQuotes(
  process.env.YO_AUTHORIZATION ??
    process.env.YO_ACCOUNT_AUTHORIZATION ??
    process.env.YO_PROXY_AUTHORIZATION ??
    configuredYoApiPassword
);

const configuredYoBaseUrl = stripWrappingQuotes(
  process.env.YO_PROXY_URL ??
    process.env.YO_BASE_URL ??
    process.env.YO_API_URL ??
    process.env.FLUTTERWAVE_BASE_URL ??
    ''
);

const configuredAtUsername = stripWrappingQuotes(process.env.AT_USERNAME ?? '');
const configuredAtApiKey = stripWrappingQuotes(process.env.AT_API_KEY ?? '');
const configuredAtSenderId = stripWrappingQuotes(
  process.env.AT_SENDER_ID ?? ''
);
const africaTalkingEnvironment =
  configuredAtUsername.trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'live';

const yoConfig = {
  allowDirectApiBypass,
  baseUrl: normalizeYoTaskUrl(
    configuredYoBaseUrl,
    DEFAULT_YO_GATEWAY_TASK_URL,
    { allowDirectHostBypass: allowDirectApiBypass }
  ),
  fallbackBaseUrl: normalizeYoTaskUrl(
    stripWrappingQuotes(
      process.env.YO_API_URL_FALLBACK ??
        process.env.YO_FALLBACK_BASE_URL ??
        process.env.YO_PROXY_URL ??
        process.env.YO_BASE_URL ??
        process.env.YO_API_URL ??
        process.env.FLUTTERWAVE_BASE_URL ??
        ''
    ),
    DEFAULT_YO_GATEWAY_TASK_URL,
    { allowDirectHostBypass: allowDirectApiBypass }
  ),
  directFailoverBaseUrls: collectDirectYoTaskUrls([
    stripWrappingQuotes(process.env.YO_API_URL_FALLBACK ?? ''),
    stripWrappingQuotes(process.env.YO_FALLBACK_BASE_URL ?? ''),
    stripWrappingQuotes(process.env.YO_API_URL ?? ''),
  ]),
  apiUsername: stripWrappingQuotes(
    process.env.YO_API_USERNAME ??
      process.env.YO_USERNAME ??
      process.env.FLUTTERWAVE_CLIENT_ID ??
      ''
  ),
  apiPassword: configuredYoApiPassword,
  authorizationCode: configuredYoAuthorization,
  webhookSecretHash: stripWrappingQuotes(
    process.env.YO_WEBHOOK_SECRET_HASH ??
      process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ??
      ''
  ),
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
  publicAppBaseUrl: stripWrappingQuotes(
    process.env.PUBLIC_APP_BASE_URL ?? 'https://primestatus.site'
  ),
  uploadDir: resolveUploadDir(),
  uploadSigningSecret: process.env.UPLOAD_SIGNING_SECRET ?? 'dev-upload-secret',
  fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
  yo: yoConfig,
  flutterwave: legacyFlutterwaveCompatConfig,
  pesapal: yoConfig,
  whatsappVerification: {
    mode:
      process.env.WHATSAPP_VERIFICATION_MODE ??
      (process.env.NODE_ENV === 'test' ? 'mock' : 'baileys'),
    baileysAuthDir:
      process.env.WHATSAPP_BAILEYS_AUTH_DIR ?? '.baileys_auth_state',
    mockAllowedPrefixes:
      process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    privateKey: stripWrappingQuotes(
      process.env.FIREBASE_PRIVATE_KEY ?? ''
    ).replace(/\\n/g, '\n'),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
  },
  africaTalking: {
    username: configuredAtUsername,
    apiKey: configuredAtApiKey,
    senderId: configuredAtSenderId,
    environment: africaTalkingEnvironment,
    baseUrl:
      africaTalkingEnvironment === 'sandbox'
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging',
  },
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

  if (!configuredYoBaseUrl.trim()) {
    issues.push(YO_PROXY_URL_MISSING_MESSAGE);
  }

  const hasYoApiUsername = config.yo.apiUsername.trim().length > 0;
  const hasYoApiPassword = config.yo.apiPassword.trim().length > 0;
  if (!hasYoApiUsername) {
    issues.push(YO_API_USERNAME_MISSING_MESSAGE);
  }
  if (!hasYoApiPassword) {
    issues.push(YO_API_PASSWORD_MISSING_MESSAGE);
  }
  if (config.yo.allowDirectApiBypass) {
    issues.push(
      'YO_ALLOW_DIRECT_API_BYPASS is enabled, so direct YO hosts can bypass the static-IP gateway'
    );
  }

  if (!config.africaTalking.username.trim()) {
    issues.push(`${AT_USERNAME_MISSING_MESSAGE}. SMS delivery is disabled.`);
  }
  if (!config.africaTalking.apiKey.trim()) {
    issues.push(`${AT_API_KEY_MISSING_MESSAGE}. SMS delivery is disabled.`);
  }
  if (!config.africaTalking.senderId.trim()) {
    issues.push('AT_SENDER_ID is missing. SMS sender branding may fail.');
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
    issue.includes(YO_API_USERNAME_MISSING_MESSAGE) ||
    issue.includes(YO_API_PASSWORD_MISSING_MESSAGE)
  );
}

export function hasYoCredentials() {
  return (
    config.yo.apiUsername.trim().length > 0 &&
    config.yo.apiPassword.trim().length > 0
  );
}

export function hasValidYoKeys() {
  return hasYoCredentials();
}

export function hasYoClientCredentials() {
  return hasYoCredentials();
}

export function hasYoLegacyApiCredentials() {
  return hasYoCredentials();
}

export function hasYoSecretKey() {
  return false;
}

export function hasAfricaTalkingCredentials() {
  return (
    config.africaTalking.username.trim().length > 0 &&
    config.africaTalking.apiKey.trim().length > 0
  );
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

export function resolveYoDirectFailoverBaseUrls() {
  return config.yo.directFailoverBaseUrls;
}

export const hasValidFlutterwaveKeys = hasValidYoKeys;
export const hasFlutterwaveClientCredentials = hasYoClientCredentials;
export const hasFlutterwaveSecretKey = hasYoSecretKey;
export const hasFlutterwaveEncryptionKey = hasYoEncryptionKey;
export const resolveFlutterwaveBaseUrl = resolveYoBaseUrl;

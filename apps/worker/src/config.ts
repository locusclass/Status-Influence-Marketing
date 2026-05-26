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

const allowDirectApiBypass = allowDirectYoHostBypass(
  process.env.YO_ALLOW_DIRECT_API_BYPASS
);
const isTestRuntime =
  process.env.NODE_ENV === 'test' ||
  String(process.env.VITEST ?? '').trim().toLowerCase() === 'true';
const allowInsecureDevDefaults =
  isTestRuntime || process.env.ALLOW_INSECURE_DEV_DEFAULTS === '1';

const yoConfig = {
  allowDirectApiBypass,
  baseUrl: normalizeYoTaskUrl(
    stripWrappingQuotes(
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
  apiPassword: stripWrappingQuotes(
    process.env.YO_API_PASSWORD ??
      process.env.YO_PASSWORD ??
      process.env.FLUTTERWAVE_CLIENT_SECRET ??
      ''
  ),
  authorizationCode: stripWrappingQuotes(
    process.env.YO_AUTHORIZATION ??
      process.env.YO_ACCOUNT_AUTHORIZATION ??
      process.env.YO_PROXY_AUTHORIZATION ??
      ''
  ),
  webhookSecretHash: stripWrappingQuotes(
    process.env.YO_WEBHOOK_SECRET_HASH ??
      process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ??
      ''
  ),
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

export function getStartupConfigIssues() {
  const issues: string[] = [];
  if (!config.databaseUrl.trim()) {
    issues.push('DATABASE_URL is missing');
  }
  if (
    !config.fingerprintPepper.trim() ||
    config.fingerprintPepper === 'dev-pepper'
  ) {
    issues.push(
      'FINGERPRINT_PEPPER is missing or using the development default'
    );
  }
  return issues;
}

export function isFatalStartupIssue(issue: string) {
  return (
    issue.includes('DATABASE_URL is missing') ||
    issue.includes(
      'FINGERPRINT_PEPPER is missing or using the development default'
    )
  );
}

export function shouldAllowInsecureDevelopmentDefaults() {
  return allowInsecureDevDefaults;
}

export function assertSecureRuntimeConfig() {
  if (shouldAllowInsecureDevelopmentDefaults()) {
    return;
  }

  const fatalIssues = getStartupConfigIssues().filter((issue) =>
    isFatalStartupIssue(issue)
  );
  if (fatalIssues.length === 0) {
    return;
  }

  throw new Error(
    `fatal_startup_configuration:${fatalIssues.join(' | ')}`
  );
}

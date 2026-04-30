export const DEFAULT_YO_GATEWAY_BASE_URL = 'http://34.79.189.141:3000/yo';
export const DEFAULT_YO_GATEWAY_TASK_URL =
  `${DEFAULT_YO_GATEWAY_BASE_URL}/ybs/task.php`;

const YO_TASK_PATH = '/ybs/task.php';
const DIRECT_YO_HOSTS = new Set([
  'paymentsapi1.yo.co.ug',
  'paymentsapi2.yo.co.ug',
]);

function isTruthyEnv(value: string | null | undefined) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function isDirectYoHost(hostname: string) {
  return DIRECT_YO_HOSTS.has(hostname.trim().toLowerCase());
}

export function isDirectYoTaskUrl(value: string | null | undefined) {
  const configured = String(value ?? '').trim();
  if (!configured) {
    return false;
  }

  try {
    return isDirectYoHost(new URL(configured).hostname);
  } catch {
    return /paymentsapi[12]\.yo\.co\.ug/i.test(configured);
  }
}

function normalizeYoTaskPath(pathname: string) {
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

export function normalizeYoTaskUrl(
  configuredValue: string | null | undefined,
  fallback = DEFAULT_YO_GATEWAY_TASK_URL,
  options?: {
    allowDirectHostBypass?: boolean;
  }
) {
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
  } catch {
    if (
      !allowDirectHostBypass &&
      /paymentsapi[12]\.yo\.co\.ug/i.test(configured)
    ) {
      return fallback;
    }
    return normalizeYoTaskPath(configured);
  }
}

export function allowDirectYoHostBypass(value: string | null | undefined) {
  return isTruthyEnv(value);
}

export function collectDirectYoTaskUrls(
  configuredValues: Array<string | null | undefined>
) {
  const urls = new Set<string>();

  for (const configuredValue of configuredValues) {
    if (!isDirectYoTaskUrl(configuredValue)) {
      continue;
    }

    urls.add(
      normalizeYoTaskUrl(configuredValue, DEFAULT_YO_GATEWAY_TASK_URL, {
        allowDirectHostBypass: true,
      })
    );
  }

  return Array.from(urls);
}

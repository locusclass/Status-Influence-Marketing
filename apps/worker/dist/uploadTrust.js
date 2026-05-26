export function resolveTrustedApiUploadUrl(rawUrl, apiBaseUrl) {
    const candidate = String(rawUrl ?? '').trim();
    const configuredBaseUrl = String(apiBaseUrl ?? '').trim();
    if (!candidate || !configuredBaseUrl) {
        return null;
    }
    try {
        const apiBase = new URL(configuredBaseUrl);
        const parsed = new URL(candidate, apiBase);
        const normalizedPath = parsed.pathname.startsWith('/api/')
            ? parsed.pathname.slice(4)
            : parsed.pathname;
        if (!normalizedPath.startsWith('/uploads/files/')) {
            return null;
        }
        if (parsed.origin !== apiBase.origin) {
            return null;
        }
        return new URL(`${normalizedPath}${parsed.search}`, apiBase).toString();
    }
    catch {
        return null;
    }
}

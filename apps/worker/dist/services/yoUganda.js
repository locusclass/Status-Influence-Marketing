import { fetch } from 'undici';
import { isDirectYoTaskUrl } from '@prime/shared';
import { config, resolveYoBaseUrl, resolveYoDirectFailoverBaseUrls, } from '../config.js';
function normalizePhoneNumber(phoneNumber) {
    const digits = phoneNumber.replace(/[^\d]/g, '');
    if (!digits) {
        return '';
    }
    if (digits.startsWith('256')) {
        return digits;
    }
    if (digits.startsWith('0')) {
        return `256${digits.slice(1)}`;
    }
    return digits;
}
function resolveAccountProviderCode(network) {
    const normalized = String(network ?? '').trim().toUpperCase();
    if (normalized === 'MTN') {
        return 'MTN_UGANDA';
    }
    if (normalized === 'AIRTEL') {
        return 'AIRTEL_UGANDA';
    }
    return undefined;
}
function failoverEndpoints() {
    return Array.from(new Set(resolveYoDirectFailoverBaseUrls().filter((endpoint) => endpoint && endpoint !== resolveYoBaseUrl())));
}
function buildRequestXml(request) {
    const body = Object.entries(request)
        .filter(([, value]) => value != null && String(value).trim().length > 0)
        .map(([key, value]) => `<${key}>${String(value)}</${key}>`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
}
async function postYoRequest(endpoint, fields) {
    const proxyMode = !isDirectYoTaskUrl(endpoint);
    // Map PascalCase fields to lowercase fields expected by YO/proxy in form-encoded mode
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
        let mappedKey = key.toLowerCase();
        if (key === 'APIUsername')
            mappedKey = 'username';
        if (key === 'APIPassword')
            mappedKey = 'password';
        if (key === 'ExternalReference')
            mappedKey = 'external_reference';
        if (key === 'InternalReference')
            mappedKey = 'internal_reference';
        if (key === 'ProviderReferenceText')
            mappedKey = 'provider_reference_text';
        if (key === 'AccountProviderCode')
            mappedKey = 'account_provider_code';
        if (key === 'NonBlocking')
            mappedKey = 'non_blocking';
        // Map Authorization to lowercase 'authorization'
        if (key === 'Authorization')
            mappedKey = 'authorization';
        formBody.append(mappedKey, value);
    }
    const bodyKeys = Array.from(formBody.keys());
    console.info(`[YO] → POST ${endpoint} proxyMode=${proxyMode} bodyKeys=[${bodyKeys.join(',')}]`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/x-www-form-urlencoded, text/xml, */*',
        },
        body: formBody,
    });
    const text = await res.text();
    console.info(`[YO] ← status=${res.status} ok=${res.ok} snippet=${JSON.stringify(text.slice(0, 100))}`);
    if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
            const parsed = JSON.parse(text);
            detail = String(parsed.details ?? parsed.error ?? detail);
        }
        catch {
            // not JSON
        }
        throw new Error(`YO Uganda payout failed: ${detail}`.trim());
    }
    return text;
}
function isGatewayFailoverError(error, endpoint) {
    if (!endpoint || isDirectYoTaskUrl(endpoint)) {
        return false;
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return (/YO proxy (request failed|error)/i.test(message) ||
        /timeout of \d+ms exceeded/i.test(message) ||
        /fetch failed/i.test(message) ||
        /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(message));
}
export async function requestPayout(input) {
    const fields = {};
    const raw = {
        Authorization: config.yo.authorizationCode,
        APIUsername: config.yo.apiUsername,
        APIPassword: config.yo.apiPassword,
        Method: 'acwithdrawfunds',
        NonBlocking: 'FALSE',
        Amount: input.amount,
        Account: normalizePhoneNumber(input.receiverPhone),
        AccountProviderCode: resolveAccountProviderCode(input.receiverNetwork),
        Narrative: input.narration,
        ExternalReference: input.reference,
        ProviderReferenceText: input.reference,
    };
    for (const [key, value] of Object.entries(raw)) {
        if (value != null && String(value).trim()) {
            fields[key] = String(value);
        }
    }
    try {
        return await postYoRequest(resolveYoBaseUrl(), fields);
    }
    catch (error) {
        if (!isGatewayFailoverError(error, resolveYoBaseUrl())) {
            throw error;
        }
        let lastError = error;
        for (const endpoint of failoverEndpoints()) {
            try {
                return await postYoRequest(endpoint, fields);
            }
            catch (failoverError) {
                lastError = failoverError;
            }
        }
        throw lastError;
    }
}

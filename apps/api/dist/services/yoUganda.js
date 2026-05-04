import { fetch } from 'undici';
import crypto from 'crypto';
import { isDirectYoTaskUrl } from '@prime/shared';
import { config, hasYoCredentials, resolveYoBaseUrl, resolveYoDirectFailoverBaseUrls, resolveYoFallbackBaseUrl, } from '../config.js';
function xmlEscape(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function xmlUnescape(value) {
    return value
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}
function uniqueEndpoints() {
    return Array.from(new Set([resolveYoBaseUrl(), resolveYoFallbackBaseUrl()].filter(Boolean)));
}
function directFailoverEndpoints() {
    return Array.from(new Set(resolveYoDirectFailoverBaseUrls().filter((endpoint) => endpoint && !uniqueEndpoints().includes(endpoint))));
}
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
function buildTraceId() {
    return crypto.randomUUID();
}
export function buildYoRequestXml(request) {
    const body = Object.entries(request)
        .filter(([, value]) => {
        if (value == null) {
            return false;
        }
        const text = String(value).trim();
        return text.length > 0;
    })
        .map(([key, value]) => {
        return `<${key}>${xmlEscape(String(value))}</${key}>`;
    })
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
}
export function parseYoResponseXml(xml) {
    const responseMatch = xml.match(/<Response>([\s\S]*?)<\/Response>/i) ??
        xml.match(/<AutoCreate>([\s\S]*?)<\/AutoCreate>/i);
    const source = responseMatch?.[1] ?? xml;
    const raw = {};
    const pattern = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = pattern.exec(source))) {
        const key = match[1];
        const rawValue = match[2];
        if (!key || rawValue == null) {
            continue;
        }
        const value = rawValue.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
        if (/<[A-Za-z]/.test(value)) {
            continue;
        }
        raw[key] = xmlUnescape(value);
    }
    const parseStatusCode = (value) => {
        if (!value) {
            return null;
        }
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    };
    return {
        status: raw.Status ?? '',
        statusCode: parseStatusCode(raw.StatusCode),
        statusMessage: raw.StatusMessage ?? null,
        errorMessage: raw.ErrorMessage ?? null,
        transactionStatus: raw.TransactionStatus ?? null,
        transactionReference: raw.TransactionReference ?? null,
        raw,
    };
}
function parseYoFormResponse(text) {
    const params = new URLSearchParams(text);
    const raw = {};
    for (const [key, value] of params.entries()) {
        raw[key] = value;
    }
    const status = params.get('ybs_autocreate_status') ?? '';
    const returnCode = params.get('ybs_autocreate_returncode');
    const message = params.get('ybs_autocreate_message') ?? null;
    const txRef = params.get('ybs_autocreate_transactionreference') ?? null;
    const txStatus = params.get('ybs_autocreate_transactionstatus') ?? null;
    const parsedCode = returnCode != null ? Number.parseInt(returnCode, 10) : null;
    return {
        status,
        statusCode: parsedCode != null && Number.isFinite(parsedCode) ? parsedCode : null,
        statusMessage: status === 'ERROR' ? null : message,
        errorMessage: status === 'ERROR' ? message : null,
        transactionStatus: txStatus,
        transactionReference: txRef,
        raw,
    };
}
export function parseYoResponse(text) {
    if (/ybs_autocreate_status/i.test(text)) {
        return parseYoFormResponse(text);
    }
    return parseYoResponseXml(text);
}
export function buildYoReferenceFields(input) {
    return {
        // YO only accepts InternalReference when linking to an existing YO transaction.
        InternalReference: input.linkedTransactionReference,
        ExternalReference: input.reference,
        ProviderReferenceText: input.providerReferenceText,
    };
}
function sanitizeResponseSnippet(text) {
    return text
        .slice(0, 300)
        .replace(/<(APIUsername|APIPassword|Authorization)>[\s\S]*?<\/\1>/gi, '<$1>[REDACTED]</$1>')
        .replace(/(APIUsername|APIPassword|Authorization)=[^&\s]*/gi, '$1=[REDACTED]');
}
function classifyYoNetworkError(message) {
    if (/ECONNREFUSED/i.test(message)) {
        return 'YO payment proxy refused the connection — check proxy is running on port 3000.';
    }
    if (/EHOSTUNREACH/i.test(message)) {
        return 'YO payment proxy host is unreachable — check proxy IP and firewall rules.';
    }
    if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(message)) {
        return 'YO payment proxy connection timed out — proxy may be down or overloaded.';
    }
    if (/fetch failed|UND_ERR_/i.test(message)) {
        return 'YO payment proxy connection failed — verify proxy is reachable from Railway.';
    }
    return message;
}
async function postYoRequest(endpoint, fields) {
    const proxyMode = !isDirectYoTaskUrl(endpoint);
    const loggedFields = Object.keys(fields).filter((k) => !['APIUsername', 'APIPassword', 'Authorization'].includes(k));
    console.info(`[YO] → POST ${endpoint} proxyMode=${proxyMode} fields=[${loggedFields.join(',')}]`);
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
        formBody.append(key, value);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res;
    let text;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/x-www-form-urlencoded, text/xml, */*',
                'X-Trace-Id': buildTraceId(),
            },
            body: formBody.toString(),
        });
        text = await res.text();
    }
    catch (fetchError) {
        const msg = fetchError instanceof Error ? fetchError.message : String(fetchError ?? '');
        console.error(`[YO] ✗ fetch error endpoint=${endpoint} error=${msg}`);
        throw new Error(classifyYoNetworkError(msg));
    }
    const snippet = sanitizeResponseSnippet(text);
    console.info(`[YO] ← status=${res.status} ok=${res.ok} snippet=${JSON.stringify(snippet)}`);
    if (!res.ok) {
        // For 5xx proxy errors extract the details field for failover classification.
        // For other errors keep the full status+body so callers see the real cause.
        if (res.status >= 500) {
            try {
                const parsed = JSON.parse(text);
                const detail = String(parsed.details ?? parsed.error ?? '');
                if (detail)
                    throw new Error(classifyYoNetworkError(detail));
            }
            catch (inner) {
                if (inner instanceof Error && !/JSON|SyntaxError/i.test(inner.message))
                    throw inner;
            }
        }
        throw new Error(`YO Uganda request failed: ${res.status} ${text.slice(0, 200)}`.trim());
    }
    if (!text.trim()) {
        throw new Error(`YO Uganda request failed: ${res.status} empty response`);
    }
    return text;
}
function isGatewayFailoverError(error, endpoint) {
    if (!endpoint || isDirectYoTaskUrl(endpoint)) {
        return false;
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return (/YO proxy (request failed|error)/i.test(message) ||
        /YO payment proxy/i.test(message) ||
        /timeout of \d+ms exceeded/i.test(message) ||
        /fetch failed/i.test(message) ||
        /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(message));
}
async function yoRequest(request) {
    if (!hasYoCredentials()) {
        throw new Error('YO Uganda API credentials are not configured');
    }
    const fields = {};
    const combined = {
        Authorization: config.yo.authorizationCode,
        APIUsername: config.yo.apiUsername,
        APIPassword: config.yo.apiPassword,
        ...request,
    };
    for (const [key, value] of Object.entries(combined)) {
        if (value != null && String(value).trim()) {
            fields[key] = String(value);
        }
    }
    const endpoints = uniqueEndpoints();
    const failoverEndpoints = directFailoverEndpoints();
    let lastError = null;
    let shouldTryDirectFailover = false;
    for (const endpoint of endpoints) {
        try {
            const responseText = await postYoRequest(endpoint, fields);
            return parseYoResponse(responseText);
        }
        catch (error) {
            if (isGatewayFailoverError(error, endpoint)) {
                shouldTryDirectFailover = true;
            }
            lastError = error;
        }
    }
    if (shouldTryDirectFailover) {
        for (const endpoint of failoverEndpoints) {
            try {
                const responseText = await postYoRequest(endpoint, fields);
                return parseYoResponse(responseText);
            }
            catch (error) {
                lastError = error;
            }
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error('YO Uganda request failed');
}
export async function initiateMobileMoneyCollection(input) {
    return yoRequest({
        Method: 'acdepositfunds',
        NonBlocking: input.nonBlocking === false ? 'FALSE' : 'TRUE',
        Amount: input.amount,
        Account: normalizePhoneNumber(input.phoneNumber),
        AccountProviderCode: resolveAccountProviderCode(input.network),
        Narrative: input.narrative,
        ...buildYoReferenceFields({
            reference: input.reference,
            providerReferenceText: input.providerReferenceText,
            linkedTransactionReference: input.linkedTransactionReference,
        }),
    });
}
export async function getTransactionStatus(transactionId, _merchantReference) {
    return yoRequest({
        Method: 'actransactioncheckstatus',
        TransactionReference: transactionId,
    });
}
export async function verifyTransaction(transactionId) {
    return getTransactionStatus(String(transactionId));
}
export async function requestPayout(input) {
    return yoRequest({
        Method: 'acwithdrawfunds',
        NonBlocking: input.nonBlocking === true ? 'TRUE' : 'FALSE',
        Amount: input.amount,
        Account: normalizePhoneNumber(input.receiverPhone),
        AccountProviderCode: resolveAccountProviderCode(input.receiverNetwork),
        Narrative: input.narration,
        ...buildYoReferenceFields({
            reference: input.reference,
            providerReferenceText: input.providerReferenceText ?? input.reference,
            linkedTransactionReference: input.linkedTransactionReference,
        }),
    });
}
export function verifyWebhookSignature(rawBody, signature, secret) {
    if (!signature || !secret) {
        return false;
    }
    if (signature === secret) {
        return true;
    }
    const hmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('base64');
    if (signature === hmac) {
        return true;
    }
    const hex = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
    return signature === hex;
}

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
export function buildYoReferenceFields(input) {
    return {
        // YO only accepts InternalReference when linking to an existing YO transaction.
        InternalReference: input.linkedTransactionReference,
        ExternalReference: input.reference,
        ProviderReferenceText: input.providerReferenceText,
    };
}
function sanitizeXmlSnippet(text) {
    return text
        .slice(0, 300)
        .replace(/<(APIUsername|APIPassword|Authorization)>[\s\S]*?<\/\1>/gi, '<$1>[REDACTED]</$1>');
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
async function postXml(endpoint, body) {
    const proxyMode = !isDirectYoTaskUrl(endpoint);
    const requestFields = Array.from(body.matchAll(/<([A-Za-z0-9_]+)>/g))
        .map((m) => m[1] ?? '')
        .filter((k) => k && !['APIUsername', 'APIPassword', 'Authorization'].includes(k));
    console.info(`[YO] → POST ${endpoint} proxyMode=${proxyMode} fields=[${requestFields.join(',')}]`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res;
    let text;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Accept: 'application/xml, text/xml, */*',
                'Content-Type': 'text/xml',
                'Content-transfer-encoding': 'text',
                'X-Trace-Id': buildTraceId(),
            },
            body,
        });
        text = await res.text();
    }
    catch (fetchError) {
        const msg = fetchError instanceof Error ? fetchError.message : String(fetchError ?? '');
        console.error(`[YO] ✗ fetch error endpoint=${endpoint} error=${msg}`);
        throw new Error(classifyYoNetworkError(msg));
    }
    const snippet = sanitizeXmlSnippet(text);
    console.info(`[YO] ← status=${res.status} ok=${res.ok} snippet=${JSON.stringify(snippet)}`);
    if (!res.ok && !/<(?:AutoCreate|Response)>/i.test(text)) {
        throw new Error(`YO Uganda request failed: ${res.status} ${sanitizeXmlSnippet(text)}`.trim());
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
    return (/YO proxy request failed/i.test(message) ||
        /timeout of \d+ms exceeded/i.test(message) ||
        /fetch failed/i.test(message) ||
        /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(message));
}
async function yoRequest(request) {
    if (!hasYoCredentials()) {
        throw new Error('YO Uganda API credentials are not configured');
    }
    const body = buildYoRequestXml({
        Authorization: config.yo.authorizationCode,
        APIUsername: config.yo.apiUsername,
        APIPassword: config.yo.apiPassword,
        ...request,
    });
    const endpoints = uniqueEndpoints();
    const failoverEndpoints = directFailoverEndpoints();
    let lastError = null;
    let shouldTryDirectFailover = false;
    for (const endpoint of endpoints) {
        try {
            const responseText = await postXml(endpoint, body);
            return parseYoResponseXml(responseText);
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
                const responseText = await postXml(endpoint, body);
                return parseYoResponseXml(responseText);
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

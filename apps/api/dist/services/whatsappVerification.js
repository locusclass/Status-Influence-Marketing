import pino from 'pino';
import { webcrypto } from 'node:crypto';
function ensureWebCryptoGlobal() {
    const globalWithCrypto = globalThis;
    if (!globalWithCrypto.crypto) {
        globalWithCrypto.crypto = webcrypto;
    }
}
const E164_MIN = 8;
const E164_MAX = 15;
function normalizePhone(phone) {
    const trimmed = phone.trim();
    if (!trimmed)
        return null;
    let normalized = trimmed.replace(/[^\d+]/g, '');
    if (normalized.startsWith('00')) {
        normalized = `+${normalized.slice(2)}`;
    }
    if (!normalized.startsWith('+')) {
        normalized = `+${normalized}`;
    }
    const digits = normalized.replace(/\D/g, '');
    if (digits.length < E164_MIN || digits.length > E164_MAX) {
        return null;
    }
    return `+${digits}`;
}
class MockWhatsAppVerifier {
    allowedPrefixes;
    constructor() {
        const raw = (process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+').trim();
        this.allowedPrefixes = raw
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }
    async verify(phone) {
        const normalized = normalizePhone(phone);
        if (!normalized) {
            return {
                ok: false,
                normalizedPhone: null,
                reason: 'invalid_phone',
                detail: 'Phone number must be in valid international format.',
                provider: 'mock',
            };
        }
        const passes = this.allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
        if (!passes) {
            return {
                ok: false,
                normalizedPhone: normalized,
                reason: 'not_on_whatsapp',
                detail: 'Mock verification rejected this phone prefix.',
                provider: 'mock',
            };
        }
        return {
            ok: true,
            normalizedPhone: normalized,
            jid: `${normalized.slice(1)}@s.whatsapp.net`,
            provider: 'mock',
        };
    }
}
class BaileysWhatsAppVerifier {
    socketPromise = null;
    authStateDir;
    connectTimeoutMs;
    pairingEnabled;
    pairingPhone;
    constructor() {
        this.authStateDir =
            process.env.WHATSAPP_BAILEYS_AUTH_DIR ?? '.baileys_auth_state';
        this.pairingEnabled =
            String(process.env.WHATSAPP_ENABLE_PAIRING ?? '')
                .trim()
                .toLowerCase() === 'true';
        this.pairingPhone = String(process.env.WHATSAPP_PAIRING_NUMBER ?? '')
            .replace(/\D/g, '')
            .trim();
        this.connectTimeoutMs = Number(process.env.WHATSAPP_BAILEYS_CONNECT_TIMEOUT_MS ??
            (this.pairingEnabled ? 120000 : 20000));
    }
    async getSocket() {
        if (!this.socketPromise) {
            this.socketPromise = this.createSocket();
        }
        return this.socketPromise;
    }
    async createSocket() {
        ensureWebCryptoGlobal();
        const baileys = await import('@whiskeysockets/baileys');
        const auth = await baileys.useMultiFileAuthState(this.authStateDir);
        const sock = baileys.makeWASocket({
            auth: auth.state,
            printQRInTerminal: !this.pairingEnabled,
            logger: pino({ level: 'silent' }),
        });
        sock.ev.on('creds.update', auth.saveCreds);
        await this.maybeEmitPairingCode(sock, Boolean(auth.state.creds?.registered));
        await this.waitForSocketConnection(sock);
        return sock;
    }
    async maybeEmitPairingCode(sock, alreadyRegistered) {
        if (!this.pairingEnabled || alreadyRegistered)
            return;
        if (!this.pairingPhone || typeof sock.requestPairingCode !== 'function') {
            console.warn('[whatsapp] Pairing is enabled but WHATSAPP_PAIRING_NUMBER or requestPairingCode is missing.');
            return;
        }
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
                // Baileys pairing code often fails if requested immediately on socket creation.
                await wait(2000 * attempt);
                const code = await sock.requestPairingCode(this.pairingPhone);
                console.info(`[whatsapp] Pairing code generated for ${this.pairingPhone}: ${code}`);
                console.info('[whatsapp] Open WhatsApp > Linked devices > Link with phone number and enter this code.');
                return;
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : 'unknown_pairing_error';
                if (attempt === 4) {
                    console.error(`[whatsapp] Failed to generate pairing code: ${detail}`);
                    return;
                }
                console.warn(`[whatsapp] Pairing code attempt ${attempt} failed (${detail}). Retrying...`);
            }
        }
    }
    async waitForSocketConnection(sock) {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                sock.ev.off('connection.update', handler);
                reject(new Error('baileys_connect_timeout'));
            }, this.connectTimeoutMs);
            const handler = (update) => {
                if (update?.connection === 'open') {
                    clearTimeout(timeout);
                    sock.ev.off('connection.update', handler);
                    resolve();
                }
            };
            sock.ev.on('connection.update', handler);
        });
    }
    async verify(phone) {
        const normalized = normalizePhone(phone);
        if (!normalized) {
            return {
                ok: false,
                normalizedPhone: null,
                reason: 'invalid_phone',
                detail: 'Phone number must be in valid international format.',
                provider: 'baileys',
            };
        }
        try {
            const sock = await this.getSocket();
            const jid = `${normalized.slice(1)}@s.whatsapp.net`;
            const results = await sock.onWhatsApp(jid);
            const hit = results?.find((row) => row?.exists === true ||
                String(row?.jid ?? '').toLowerCase() === jid.toLowerCase());
            if (!hit) {
                return {
                    ok: false,
                    normalizedPhone: normalized,
                    reason: 'not_on_whatsapp',
                    detail: 'Number is not registered on WhatsApp.',
                    provider: 'baileys',
                };
            }
            return {
                ok: true,
                normalizedPhone: normalized,
                jid: hit.jid ?? jid,
                provider: 'baileys',
            };
        }
        catch (error) {
            this.socketPromise = null;
            return {
                ok: false,
                normalizedPhone: normalized,
                reason: 'provider_unavailable',
                detail: error instanceof Error ? error.message : 'Baileys verification failed.',
                provider: 'baileys',
            };
        }
    }
}
function resolveMode() {
    const configured = (process.env.WHATSAPP_VERIFICATION_MODE ?? '')
        .trim()
        .toLowerCase();
    if (configured === 'baileys')
        return 'baileys';
    if (configured === 'mock')
        return 'mock';
    return process.env.NODE_ENV === 'test' ? 'mock' : 'baileys';
}
class WhatsAppVerificationService {
    impl = resolveMode() === 'baileys'
        ? new BaileysWhatsAppVerifier()
        : new MockWhatsAppVerifier();
    async verifyPhone(phone) {
        return this.impl.verify(phone);
    }
}
export const whatsappVerificationService = new WhatsAppVerificationService();

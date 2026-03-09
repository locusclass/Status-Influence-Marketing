import pino from 'pino';
import { webcrypto } from 'node:crypto';

type VerifyFailureReason =
  | 'invalid_phone'
  | 'not_on_whatsapp'
  | 'provider_unavailable'
  | 'pairing_required';

export type WhatsAppVerificationResult =
  | {
      ok: true;
      normalizedPhone: string;
      jid: string | null;
      provider: 'mock' | 'baileys';
    }
  | {
      ok: false;
      normalizedPhone: string | null;
      reason: VerifyFailureReason;
      detail: string;
      provider: 'mock' | 'baileys';
      pairingCode?: string | null;
      pairingPhone?: string | null;
    };

type VerifyPayload = {
  exists?: boolean;
  jid?: string | null;
};

type SockLike = {
  ev: {
    on: (event: string, handler: (update: any) => void) => void;
    off: (event: string, handler: (update: any) => void) => void;
  };
  onWhatsApp: (...jids: string[]) => Promise<VerifyPayload[]>;
  requestPairingCode?: (phoneNumber: string) => Promise<string>;
};

function ensureWebCryptoGlobal() {
  const globalWithCrypto = globalThis as typeof globalThis & {
    crypto?: Crypto;
  };
  if (!globalWithCrypto.crypto) {
    globalWithCrypto.crypto = webcrypto as unknown as Crypto;
  }
}

const E164_MIN = 8;
const E164_MAX = 15;

function normalizePhone(phone: string) {
  const trimmed = phone.trim();
  if (!trimmed) return null;

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
  private readonly allowedPrefixes: string[];

  constructor() {
    const raw = (process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES ?? '+').trim();
    this.allowedPrefixes = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async verify(phone: string): Promise<WhatsAppVerificationResult> {
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

    const passes = this.allowedPrefixes.some((prefix) =>
      normalized.startsWith(prefix)
    );
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
  private socketPromise: Promise<SockLike> | null = null;
  private pairingBootstrapPromise: Promise<void> | null = null;
  private readonly authStateDir: string;
  private readonly connectTimeoutMs: number;
  private readonly pairingEnabled: boolean;
  private readonly pairingPhone: string;
  private socketOpen = false;
  private credsRegistered = false;
  private lastPairingCode: string | null = null;
  private pairingRequestedAt: number | null = null;
  private lastProviderError: string | null = null;

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
    this.connectTimeoutMs = Number(
      process.env.WHATSAPP_BAILEYS_CONNECT_TIMEOUT_MS ?? 12000
    );
  }

  private async getSocket(): Promise<SockLike> {
    if (!this.socketPromise) {
      this.socketPromise = this.createSocket();
    }
    return this.socketPromise;
  }

  private async createSocket(): Promise<SockLike> {
    ensureWebCryptoGlobal();
    const baileys = await import('@whiskeysockets/baileys');
    const auth = await baileys.useMultiFileAuthState(this.authStateDir);
    this.credsRegistered = Boolean(auth.state.creds?.registered);
    const sock = baileys.makeWASocket({
      auth: auth.state,
      printQRInTerminal: !this.pairingEnabled,
      logger: pino({ level: 'silent' }),
    }) as SockLike;

    sock.ev.on('creds.update', (creds: any) => {
      auth.saveCreds();
      this.credsRegistered = Boolean(creds?.registered) || this.credsRegistered;
    });
    sock.ev.on('connection.update', (update: any) => {
      if (update?.connection === 'open') {
        this.socketOpen = true;
        this.lastProviderError = null;
      }
      if (update?.connection === 'close') {
        this.socketOpen = false;
        const detail =
          update?.lastDisconnect?.error?.message ??
          update?.lastDisconnect?.error?.toString?.() ??
          'Connection Closed';
        this.lastProviderError = String(detail);
      }
    });

    const alreadyRegistered = Boolean(auth.state.creds?.registered);
    if (this.pairingEnabled && !alreadyRegistered) {
      this.pairingBootstrapPromise ??= this.bootstrapPairing(sock).finally(() => {
        this.pairingBootstrapPromise = null;
      });
      return sock;
    }

    await this.waitForSocketConnection(sock);
    this.socketOpen = true;
    return sock;
  }

  private async bootstrapPairing(sock: SockLike) {
    await this.maybeEmitPairingCode(sock, false);
    try {
      await this.waitForSocketConnection(sock);
      this.socketOpen = true;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'pairing_socket_not_open';
      this.lastProviderError = detail;
    }
  }

  private async maybeEmitPairingCode(sock: SockLike, alreadyRegistered: boolean) {
    if (!this.pairingEnabled || alreadyRegistered) return;
    if (!this.pairingPhone || typeof sock.requestPairingCode !== 'function') {
      console.warn(
        '[whatsapp] Pairing is enabled but WHATSAPP_PAIRING_NUMBER or requestPairingCode is missing.'
      );
      return;
    }

    const wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        // Baileys pairing code often fails if requested immediately on socket creation.
        await wait(2000 * attempt);
        const code = await sock.requestPairingCode(this.pairingPhone);
        this.lastPairingCode = code;
        this.pairingRequestedAt = Date.now();
        console.info(
          `[whatsapp] Pairing code generated for ${this.pairingPhone}: ${code}`
        );
        console.info(
          '[whatsapp] Open WhatsApp > Linked devices > Link with phone number and enter this code.'
        );
        return;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'unknown_pairing_error';
        this.lastProviderError = detail;
        if (attempt === 4) {
          console.error(`[whatsapp] Failed to generate pairing code: ${detail}`);
          return;
        }
        console.warn(
          `[whatsapp] Pairing code attempt ${attempt} failed (${detail}). Retrying...`
        );
      }
    }
  }

  private async waitForSocketConnection(sock: SockLike) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sock.ev.off('connection.update', handler);
        reject(new Error('baileys_connect_timeout'));
      }, this.connectTimeoutMs);

      const handler = (update: any) => {
        if (update?.connection === 'open') {
          clearTimeout(timeout);
          sock.ev.off('connection.update', handler);
          resolve();
        }
      };

      sock.ev.on('connection.update', handler);
    });
  }

  async verify(phone: string): Promise<WhatsAppVerificationResult> {
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

    if (this.pairingEnabled && !this.credsRegistered && !this.socketOpen) {
      this.getSocket().catch((error) => {
        this.socketPromise = null;
        this.lastProviderError =
          error instanceof Error ? error.message : 'pairing_bootstrap_failed';
      });
      return {
        ok: false,
        normalizedPhone: normalized,
        reason: 'pairing_required',
        detail:
          (this.lastProviderError?.trim().length ?? 0) > 0
            ? `WhatsApp needs linking first (${this.lastProviderError}).`
            : 'WhatsApp needs to be linked first using pairing code.',
        provider: 'baileys',
        pairingCode: this.lastPairingCode,
        pairingPhone: this.pairingPhone || null,
      };
    }

    try {
      const sock = await this.getSocket();
      const jid = `${normalized.slice(1)}@s.whatsapp.net`;
      const results = await sock.onWhatsApp(jid);
      const hit = results?.find(
        (row) =>
          row?.exists === true ||
          String(row?.jid ?? '').toLowerCase() === jid.toLowerCase()
      );

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
    } catch (error) {
      this.socketPromise = null;
      const detail =
        error instanceof Error ? error.message : 'Baileys verification failed.';
      if (
        this.pairingEnabled &&
        (detail.includes('timeout') ||
          detail.includes('closed') ||
          detail.includes('Connection Closed') ||
          detail.includes('baileys_connect_timeout'))
      ) {
        return {
          ok: false,
          normalizedPhone: normalized,
          reason: 'pairing_required',
          detail: 'WhatsApp needs to be linked first using pairing code.',
          provider: 'baileys',
          pairingCode: this.lastPairingCode,
          pairingPhone: this.pairingPhone || null,
        };
      }
      return {
        ok: false,
        normalizedPhone: normalized,
        reason: 'provider_unavailable',
        detail,
        provider: 'baileys',
      };
    }
  }

  getStatus() {
    const pairingAgeSeconds =
      this.pairingRequestedAt == null
        ? null
        : Math.max(0, Math.floor((Date.now() - this.pairingRequestedAt) / 1000));

    return {
      provider: 'baileys' as const,
      pairingEnabled: this.pairingEnabled,
      socketOpen: this.socketOpen,
      credsRegistered: this.credsRegistered,
      pairingPhone: this.pairingPhone || null,
      pairingCode: this.lastPairingCode,
      pairingAgeSeconds,
      lastProviderError: this.lastProviderError,
    };
  }
}

function resolveMode() {
  const configured = (process.env.WHATSAPP_VERIFICATION_MODE ?? '')
    .trim()
    .toLowerCase();
  if (configured === 'baileys') return 'baileys';
  if (configured === 'mock') return 'mock';
  return process.env.NODE_ENV === 'test' ? 'mock' : 'baileys';
}

class WhatsAppVerificationService {
  private readonly impl =
    resolveMode() === 'baileys'
      ? new BaileysWhatsAppVerifier()
      : new MockWhatsAppVerifier();

  async verifyPhone(phone: string) {
    return this.impl.verify(phone);
  }

  getStatus() {
    if ('getStatus' in this.impl && typeof this.impl.getStatus === 'function') {
      return this.impl.getStatus();
    }
    return {
      provider: 'mock' as const,
      pairingEnabled: false,
      pairingPhone: null,
      pairingCode: null,
      pairingAgeSeconds: null,
      lastProviderError: null,
    };
  }
}

export const whatsappVerificationService = new WhatsAppVerificationService();

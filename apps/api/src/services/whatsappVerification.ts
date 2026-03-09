import pino from 'pino';

type VerifyFailureReason =
  | 'invalid_phone'
  | 'not_on_whatsapp'
  | 'provider_unavailable';

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
  private readonly authStateDir: string;
  private readonly connectTimeoutMs: number;
  private readonly pairingEnabled: boolean;
  private readonly pairingPhone: string;

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
      process.env.WHATSAPP_BAILEYS_CONNECT_TIMEOUT_MS ??
        (this.pairingEnabled ? 120000 : 20000)
    );
  }

  private async getSocket(): Promise<SockLike> {
    if (!this.socketPromise) {
      this.socketPromise = this.createSocket();
    }
    return this.socketPromise;
  }

  private async createSocket(): Promise<SockLike> {
    const baileys = await import('@whiskeysockets/baileys');
    const auth = await baileys.useMultiFileAuthState(this.authStateDir);
    const sock = baileys.makeWASocket({
      auth: auth.state,
      printQRInTerminal: !this.pairingEnabled,
      logger: pino({ level: 'silent' }),
    }) as SockLike;

    sock.ev.on('creds.update', auth.saveCreds);
    await this.maybeEmitPairingCode(sock, Boolean(auth.state.creds?.registered));
    await this.waitForSocketConnection(sock);
    return sock;
  }

  private async maybeEmitPairingCode(sock: SockLike, alreadyRegistered: boolean) {
    if (!this.pairingEnabled || alreadyRegistered) return;
    if (!this.pairingPhone || typeof sock.requestPairingCode !== 'function') {
      console.warn(
        '[whatsapp] Pairing is enabled but WHATSAPP_PAIRING_NUMBER or requestPairingCode is missing.'
      );
      return;
    }

    try {
      const code = await sock.requestPairingCode(this.pairingPhone);
      console.info(
        `[whatsapp] Pairing code generated for ${this.pairingPhone}: ${code}`
      );
      console.info(
        '[whatsapp] Open WhatsApp > Linked devices > Link with phone number and enter this code.'
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'unknown_pairing_error';
      console.error(`[whatsapp] Failed to generate pairing code: ${detail}`);
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
      return {
        ok: false,
        normalizedPhone: normalized,
        reason: 'provider_unavailable',
        detail:
          error instanceof Error ? error.message : 'Baileys verification failed.',
        provider: 'baileys',
      };
    }
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
}

export const whatsappVerificationService = new WhatsAppVerificationService();

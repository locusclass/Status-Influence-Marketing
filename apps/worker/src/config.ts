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

const flutterwaveConfig = {
  baseUrl: stripWrappingQuotes(process.env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com/v3'),
  secretKey: stripWrappingQuotes(process.env.FLUTTERWAVE_SECRET_KEY ?? ''),
  publicKey: stripWrappingQuotes(process.env.FLUTTERWAVE_PUBLIC_KEY ?? ''),
  webhookSecretHash: stripWrappingQuotes(process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? ''),
};

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
  flutterwave: flutterwaveConfig,
  pesapal: flutterwaveConfig,
};

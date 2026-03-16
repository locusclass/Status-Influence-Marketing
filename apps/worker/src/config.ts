const flutterwaveConfig = {
  baseUrl: process.env.FLUTTERWAVE_BASE_URL ?? 'https://api.flutterwave.com/v3',
  secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? '',
  publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
  webhookSecretHash: process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? '',
};

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
  flutterwave: flutterwaveConfig,
  pesapal: flutterwaveConfig,
};

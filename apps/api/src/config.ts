export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  uploadSigningSecret: process.env.UPLOAD_SIGNING_SECRET ?? 'dev-upload-secret',
  fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
  pesapal: {
    env: process.env.PESAPAL_ENV ?? 'sandbox',
    baseUrl: process.env.PESAPAL_BASE_URL ?? 'https://cybqa.pesapal.com/pesapalv3',
    consumerKey: process.env.PESAPAL_CONSUMER_KEY ?? '',
    consumerSecret: process.env.PESAPAL_CONSUMER_SECRET ?? '',
    ipnId: process.env.PESAPAL_IPN_ID ?? '',
    callbackUrl: process.env.PESAPAL_CALLBACK_URL ?? '',
    payoutCallbackUrl: process.env.PESAPAL_PAYOUT_CALLBACK_URL ?? '',
    payoutWebhookSecret: process.env.PESAPAL_PAYOUT_WEBHOOK_SECRET ?? ''
  }
};

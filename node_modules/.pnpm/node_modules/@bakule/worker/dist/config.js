export const config = {
    port: parseInt(process.env.PORT ?? '3001', 10),
    databaseUrl: process.env.DATABASE_URL ?? '',
    fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
    pesapal: {
        env: process.env.PESAPAL_ENV ?? 'sandbox',
        baseUrl: process.env.PESAPAL_BASE_URL ?? 'https://cybqa.pesapal.com/pesapalv3',
        consumerKey: process.env.PESAPAL_CONSUMER_KEY ?? '',
        consumerSecret: process.env.PESAPAL_CONSUMER_SECRET ?? '',
        payoutCallbackUrl: process.env.PESAPAL_PAYOUT_CALLBACK_URL ?? '',
        payoutWebhookSecret: process.env.PESAPAL_PAYOUT_WEBHOOK_SECRET ?? ''
    }
};

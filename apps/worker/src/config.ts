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

const yoConfig = {
  baseUrl: stripWrappingQuotes(
    process.env.YO_API_URL ??
      process.env.YO_BASE_URL ??
      process.env.FLUTTERWAVE_BASE_URL ??
      'https://paymentsapi1.yo.co.ug/ybs/task.php'
  ),
  apiUsername: stripWrappingQuotes(
    process.env.YO_API_USERNAME ??
      process.env.YO_USERNAME ??
      process.env.FLUTTERWAVE_CLIENT_ID ??
      ''
  ),
  apiPassword: stripWrappingQuotes(
    process.env.YO_API_PASSWORD ??
      process.env.YO_PASSWORD ??
      process.env.FLUTTERWAVE_CLIENT_SECRET ??
      ''
  ),
  webhookSecretHash: stripWrappingQuotes(
    process.env.YO_WEBHOOK_SECRET_HASH ??
      process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ??
      ''
  ),
};

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  fingerprintPepper: process.env.FINGERPRINT_PEPPER ?? 'dev-pepper',
  yo: yoConfig,
  flutterwave: {
    baseUrl: yoConfig.baseUrl,
    secretKey: '',
    publicKey: '',
    webhookSecretHash: yoConfig.webhookSecretHash,
  },
  pesapal: yoConfig,
};

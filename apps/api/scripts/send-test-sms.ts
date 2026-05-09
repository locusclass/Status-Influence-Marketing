import 'dotenv/config';
import { dispatchSmsJob } from '../src/services/smsDispatch.js';
import { isAfricaTalkingSandbox } from '../src/services/sms.js';

async function main() {
  const [phone, ...messageParts] = process.argv.slice(2);
  if (!phone) {
    console.error(
      'Usage: pnpm --filter @prime/api sms:test -- <phone> [message]'
    );
    process.exit(1);
  }

  const message =
    messageParts.join(' ').trim() ||
    `Prime Status SMS test at ${new Date().toISOString()}`;

  const result = await dispatchSmsJob({
    phone,
    message,
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        status: result.providerStatus,
        environment: isAfricaTalkingSandbox() ? 'sandbox' : 'live',
        normalized_phone: result.normalizedPhone,
        log_id: result.logId,
        error: result.error,
        response: result.response,
      },
      null,
      2
    )
  );

  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { createUserNotifications, type NotificationInput } from './userSignals.js';
import type { SmsDispatchJob } from './smsDispatch.js';

type NotificationRecipient = {
  id: string;
  phone: string | null;
  full_name: string | null;
  email: string | null;
};

type NotificationSmsOptions = {
  enabled?: boolean;
  message:
    | string
    | ((recipient: NotificationRecipient) => string | null | undefined);
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(value: unknown) {
  const text = String(value ?? '').trim();
  return UUID_PATTERN.test(text) ? text : null;
}

async function loadRecipients(client: any, userIds: unknown[]) {
  const normalized = Array.from(
    new Set(
      userIds
        .map((value) => normalizeUuid(value))
        .filter((value): value is string => Boolean(value))
    )
  );

  if (normalized.length === 0) {
    return [] as NotificationRecipient[];
  }

  const res = await client.query(
    `
    SELECT id, phone, full_name, email
    FROM users
    WHERE id = ANY($1::uuid[])
    `,
    [normalized]
  );

  return res.rows.map(
    (row: any): NotificationRecipient => ({
      id: String(row.id),
      phone: row.phone == null ? null : String(row.phone),
      full_name: row.full_name == null ? null : String(row.full_name),
      email: row.email == null ? null : String(row.email),
    })
  );
}

export async function createUserNotificationsWithSmsPlan(
  client: any,
  userIds: unknown[],
  notification: NotificationInput,
  options?: {
    sms?: NotificationSmsOptions;
  }
) {
  await createUserNotifications(client, userIds, notification);

  if (!options?.sms?.enabled) {
    return { smsJobs: [] as SmsDispatchJob[] };
  }

  const recipients = await loadRecipients(client, userIds);
  const smsJobs = recipients
    .map((recipient: NotificationRecipient): SmsDispatchJob | null => {
      const resolvedMessage =
        typeof options.sms?.message === 'function'
          ? options.sms.message(recipient)
          : options.sms?.message;
      const message = String(resolvedMessage ?? '').trim();
      const phone = String(recipient.phone ?? '').trim();
      if (!message || !phone) {
        return null;
      }
      return {
        userId: recipient.id,
        phone,
        message,
      };
    })
    .filter((job: SmsDispatchJob | null): job is SmsDispatchJob => Boolean(job));

  return { smsJobs };
}

import { beforeAll, describe, expect, it } from 'vitest';
import { getTestPool, applySchema } from './db.js';
import {
  createUserNotifications,
  deleteUserNotification,
  ensureUserSignalSchema,
  listUserNotifications,
  markAllUserNotificationsRead,
  updateUserNotificationReadState,
} from '../src/services/userSignals.js';

const pool = getTestPool();

describe('User notifications', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    await applySchema(pool);
    await ensureUserSignalSchema(pool);
  });

  it('supports read/unread updates and deletion', async () => {
    const seed = Date.now();
    const user = await pool.query(
      `
      INSERT INTO users (email, phone, password_hash, role)
      VALUES ($1, $2, 'x', 'DISTRIBUTOR')
      RETURNING id
      `,
      [
        `notifications.${seed}@example.com`,
        `+2567${String(seed).slice(-8)}`,
      ]
    );
    const userId = String(user.rows[0].id);

    await createUserNotifications(pool, [userId], {
      title: 'Account updated',
      body: 'Your profile has new activity.',
      category: 'SYSTEM',
    });

    const listed = await listUserNotifications(pool, userId, { limit: 10 });
    expect(listed.notifications).toHaveLength(1);
    expect(listed.unreadCount).toBe(1);

    const notificationId = String(listed.notifications[0].id);
    const readState = await updateUserNotificationReadState(
      pool,
      userId,
      notificationId,
      true
    );
    expect(readState?.read_at).toBeTruthy();

    const unreadAfterRead = await listUserNotifications(pool, userId, {
      limit: 10,
      unreadOnly: true,
    });
    expect(unreadAfterRead.notifications).toHaveLength(0);
    expect(unreadAfterRead.unreadCount).toBe(0);

    const unreadState = await updateUserNotificationReadState(
      pool,
      userId,
      notificationId,
      false
    );
    expect(unreadState?.read_at).toBeNull();

    const deletedId = await deleteUserNotification(pool, userId, notificationId);
    expect(deletedId).toBe(notificationId);

    const afterDelete = await listUserNotifications(pool, userId, {
      limit: 10,
    });
    expect(afterDelete.notifications).toHaveLength(0);
    expect(afterDelete.unreadCount).toBe(0);
  });

  it('clears the inbox when marking all notifications as read', async () => {
    const seed = Date.now() + 1;
    const user = await pool.query(
      `
      INSERT INTO users (email, phone, password_hash, role)
      VALUES ($1, $2, 'x', 'DISTRIBUTOR')
      RETURNING id
      `,
      [
        `notifications.clear.${seed}@example.com`,
        `+2567${String(seed).slice(-8)}`,
      ]
    );
    const userId = String(user.rows[0].id);

    await createUserNotifications(pool, [userId], {
      title: 'Unread notice',
      body: 'This should disappear.',
      category: 'SYSTEM',
    });
    await createUserNotifications(pool, [userId], {
      title: 'Another notice',
      body: 'This should also disappear.',
      category: 'SYSTEM',
    });

    const before = await listUserNotifications(pool, userId, { limit: 10 });
    expect(before.notifications).toHaveLength(2);
    expect(before.unreadCount).toBe(2);

    const cleared = await markAllUserNotificationsRead(pool, userId);
    expect(cleared).toBe(2);

    const after = await listUserNotifications(pool, userId, { limit: 10 });
    expect(after.notifications).toHaveLength(0);
    expect(after.unreadCount).toBe(0);
  });
});

/**
 * media-upload.test.ts
 *
 * Unit tests for the media-upload pipeline logic extracted from uploads.ts.
 * These tests do NOT hit the database or Firebase — they exercise the pure
 * validation and access-control functions directly.
 */

import { describe, it, expect } from 'vitest';

// ─── Replicated pure helpers from uploads.ts ─────────────────────────────────
// (We duplicate the small helper functions here to keep tests self-contained
//  without importing the Fastify route file which requires a running app.)

const VALID_PURPOSES = new Set([
  'campaign_banner', 'campaign_gallery', 'campaign_video', 'landing_page_media',
  'ambassador_proof_screenshot', 'ambassador_proof_screen_recording',
  'user_avatar', 'business_logo', 'admin_attachment',
]);

const PROOF_PURPOSES = new Set([
  'ambassador_proof_screenshot',
  'ambassador_proof_screen_recording',
]);

const SIZE_LIMITS: Record<string, number> = {
  campaign_banner:                   8  * 1024 * 1024,
  campaign_gallery:                  10 * 1024 * 1024,
  campaign_video:                    100 * 1024 * 1024,
  landing_page_media:                100 * 1024 * 1024,
  ambassador_proof_screenshot:       10 * 1024 * 1024,
  ambassador_proof_screen_recording: 250 * 1024 * 1024,
  user_avatar:                       5  * 1024 * 1024,
  business_logo:                     5  * 1024 * 1024,
  admin_attachment:                  50 * 1024 * 1024,
};

const ALLOWED_MIMES: Record<string, string[]> = {
  campaign_banner:                   ['image/'],
  campaign_gallery:                  ['image/'],
  campaign_video:                    ['video/'],
  landing_page_media:                ['image/', 'video/'],
  ambassador_proof_screenshot:       ['image/'],
  ambassador_proof_screen_recording: ['video/mp4'],
  user_avatar:                       ['image/'],
  business_logo:                     ['image/'],
  admin_attachment:                  ['image/', 'video/', 'application/pdf'],
};

const BLOCKED_MIMES = new Set([
  'application/x-msdownload', 'application/x-executable',
  'application/x-sh', 'text/x-shellscript', 'application/x-bat',
]);

function isMimeAllowed(mime: string, purpose: string): boolean {
  if (BLOCKED_MIMES.has(mime)) return false;
  const allowed = ALLOWED_MIMES[purpose] ?? ['image/', 'video/'];
  return allowed.some((prefix) => mime.startsWith(prefix));
}

function storagePath(purpose: string, userId: string, fileId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const name = `${fileId}-${safe}`;
  if (purpose.startsWith('ambassador_proof')) return `proofs/${userId}/${name}`;
  if (purpose === 'user_avatar' || purpose === 'business_logo') return `users/${userId}/${purpose}/${name}`;
  if (purpose === 'admin_attachment') return `admin/${userId}/${name}`;
  return `campaigns/media/${name}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('upload purpose validation', () => {
  it('accepts all valid purposes', () => {
    for (const p of VALID_PURPOSES) {
      expect(VALID_PURPOSES.has(p)).toBe(true);
    }
  });

  it('rejects an unknown purpose', () => {
    expect(VALID_PURPOSES.has('random_purpose')).toBe(false);
    expect(VALID_PURPOSES.has('')).toBe(false);
  });
});

describe('MIME-type validation', () => {
  it('allows image/jpeg for campaign_banner', () => {
    expect(isMimeAllowed('image/jpeg', 'campaign_banner')).toBe(true);
  });

  it('blocks video/mp4 for campaign_banner', () => {
    expect(isMimeAllowed('video/mp4', 'campaign_banner')).toBe(false);
  });

  it('allows video/mp4 for campaign_video', () => {
    expect(isMimeAllowed('video/mp4', 'campaign_video')).toBe(true);
  });

  it('blocks image/png for ambassador_proof_screen_recording (only video/mp4 allowed)', () => {
    expect(isMimeAllowed('image/png', 'ambassador_proof_screen_recording')).toBe(false);
  });

  it('allows video/mp4 for ambassador_proof_screen_recording', () => {
    expect(isMimeAllowed('video/mp4', 'ambassador_proof_screen_recording')).toBe(true);
  });

  it('blocks video/avi for ambassador_proof_screen_recording', () => {
    expect(isMimeAllowed('video/avi', 'ambassador_proof_screen_recording')).toBe(false);
  });

  it('allows application/pdf for admin_attachment', () => {
    expect(isMimeAllowed('application/pdf', 'admin_attachment')).toBe(true);
  });

  it('blocks executable MIME types regardless of purpose', () => {
    expect(isMimeAllowed('application/x-msdownload', 'admin_attachment')).toBe(false);
    expect(isMimeAllowed('application/x-sh', 'campaign_banner')).toBe(false);
    expect(isMimeAllowed('application/x-executable', 'campaign_video')).toBe(false);
  });

  it('allows image and video for landing_page_media', () => {
    expect(isMimeAllowed('image/webp', 'landing_page_media')).toBe(true);
    expect(isMimeAllowed('video/mp4', 'landing_page_media')).toBe(true);
  });
});

describe('file size limits', () => {
  it('proof recording has the largest limit (250 MB)', () => {
    expect(SIZE_LIMITS.ambassador_proof_screen_recording).toBe(250 * 1024 * 1024);
  });

  it('avatar has a small limit (5 MB)', () => {
    expect(SIZE_LIMITS.user_avatar).toBe(5 * 1024 * 1024);
  });

  it('campaign video is 100 MB', () => {
    expect(SIZE_LIMITS.campaign_video).toBe(100 * 1024 * 1024);
  });

  it('every purpose has a defined limit', () => {
    for (const purpose of VALID_PURPOSES) {
      expect(SIZE_LIMITS[purpose]).toBeGreaterThan(0);
    }
  });
});

describe('proof purpose detection', () => {
  it('marks screenshot and recording as proof purposes', () => {
    expect(PROOF_PURPOSES.has('ambassador_proof_screenshot')).toBe(true);
    expect(PROOF_PURPOSES.has('ambassador_proof_screen_recording')).toBe(true);
  });

  it('does not mark campaign or avatar media as proof', () => {
    expect(PROOF_PURPOSES.has('campaign_gallery')).toBe(false);
    expect(PROOF_PURPOSES.has('user_avatar')).toBe(false);
  });
});

describe('storage path generation', () => {
  it('puts proof media under proofs/{userId}/', () => {
    const p = storagePath('ambassador_proof_screen_recording', 'user-123', 'file-abc', 'proof.mp4');
    expect(p.startsWith('proofs/user-123/')).toBe(true);
  });

  it('puts campaign media under campaigns/media/', () => {
    const p = storagePath('campaign_gallery', 'user-123', 'file-abc', 'image.jpg');
    expect(p.startsWith('campaigns/media/')).toBe(true);
  });

  it('puts avatar under users/{userId}/user_avatar/', () => {
    const p = storagePath('user_avatar', 'user-123', 'file-abc', 'avatar.png');
    expect(p.startsWith('users/user-123/user_avatar/')).toBe(true);
  });

  it('sanitises unsafe characters in filenames', () => {
    const p = storagePath('campaign_gallery', 'u1', 'f1', 'my file (1).jpg');
    expect(p).not.toContain(' ');
    expect(p).not.toContain('(');
  });

  it('puts admin attachments under admin/{userId}/', () => {
    const p = storagePath('admin_attachment', 'admin-999', 'file-xyz', 'doc.pdf');
    expect(p.startsWith('admin/admin-999/')).toBe(true);
  });
});

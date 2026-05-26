import { describe, expect, it } from 'vitest';

import { resolveTrustedApiUploadUrl } from '../src/uploadTrust.js';

describe('resolveTrustedApiUploadUrl', () => {
  const apiBaseUrl = 'https://api.primestatus.site';

  it('accepts same-origin upload file URLs', () => {
    expect(
      resolveTrustedApiUploadUrl(
        'https://api.primestatus.site/uploads/files/campaigns%2Fmedia%2Fasset.jpg?mime=image%2Fjpeg',
        apiBaseUrl
      )
    ).toBe(
      'https://api.primestatus.site/uploads/files/campaigns%2Fmedia%2Fasset.jpg?mime=image%2Fjpeg'
    );
  });

  it('normalizes same-origin /api upload paths', () => {
    expect(
      resolveTrustedApiUploadUrl(
        'https://api.primestatus.site/api/uploads/files/campaigns%2Fmedia%2Fasset.jpg?mime=image%2Fjpeg',
        apiBaseUrl
      )
    ).toBe(
      'https://api.primestatus.site/uploads/files/campaigns%2Fmedia%2Fasset.jpg?mime=image%2Fjpeg'
    );
  });

  it('rejects off-origin URLs', () => {
    expect(
      resolveTrustedApiUploadUrl(
        'https://evil.example/uploads/files/campaigns%2Fmedia%2Fasset.jpg?mime=image%2Fjpeg',
        apiBaseUrl
      )
    ).toBeNull();
  });

  it('rejects non-upload URLs on the right origin', () => {
    expect(
      resolveTrustedApiUploadUrl(
        'https://api.primestatus.site/internal/metadata',
        apiBaseUrl
      )
    ).toBeNull();
  });
});

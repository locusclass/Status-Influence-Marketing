import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;
const ORIGINAL_JWT_PREVIOUS_SECRETS = process.env.JWT_PREVIOUS_SECRETS;

async function loadConfig(input: {
  jwtExpiresIn?: string;
  jwtPreviousSecrets?: string;
} = {}) {
  const { jwtExpiresIn, jwtPreviousSecrets } = input;
  if (jwtExpiresIn == null) {
    delete process.env.JWT_EXPIRES_IN;
  } else {
    process.env.JWT_EXPIRES_IN = jwtExpiresIn;
  }
  if (jwtPreviousSecrets == null) {
    delete process.env.JWT_PREVIOUS_SECRETS;
  } else {
    process.env.JWT_PREVIOUS_SECRETS = jwtPreviousSecrets;
  }

  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  if (ORIGINAL_JWT_EXPIRES_IN == null) {
    delete process.env.JWT_EXPIRES_IN;
  } else {
    process.env.JWT_EXPIRES_IN = ORIGINAL_JWT_EXPIRES_IN;
  }
  if (ORIGINAL_JWT_PREVIOUS_SECRETS == null) {
    delete process.env.JWT_PREVIOUS_SECRETS;
  } else {
    process.env.JWT_PREVIOUS_SECRETS = ORIGINAL_JWT_PREVIOUS_SECRETS;
  }
  vi.resetModules();
});

describe('session config', () => {
  it('defaults API sessions to a mobile-friendly lifetime', async () => {
    const configModule = await loadConfig();

    expect(configModule.config.jwtExpiresIn).toBe('30d');
  });

  it('allows deployments to override the JWT lifetime', async () => {
    const configModule = await loadConfig({ jwtExpiresIn: '7d' });

    expect(configModule.config.jwtExpiresIn).toBe('7d');
  });

  it('parses previous JWT secrets for rotation compatibility', async () => {
    const configModule = await loadConfig({
      jwtPreviousSecrets: 'old-one, old-two, old-one',
    });

    expect(configModule.config.jwtPreviousSecrets).toEqual([
      'old-one',
      'old-two',
    ]);
  });
});

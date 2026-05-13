import { describe, expect, it } from 'vitest';

import {
  canAccessAmbassadorFeatures,
  canAccessBusinessFeatures,
  normalizeAccountRole,
} from '../src/services/roles.js';

describe('role normalization', () => {
  it('accepts user-like objects when checking business access', () => {
    expect(canAccessBusinessFeatures({ role: 'BUSINESS' })).toBe(true);
    expect(canAccessBusinessFeatures({ role: 'DUAL_USER' })).toBe(true);
    expect(canAccessBusinessFeatures({ role: 'AMBASSADOR' })).toBe(false);
  });

  it('accepts active_role as a fallback on user-like objects', () => {
    expect(normalizeAccountRole({ active_role: 'BUSINESS' })).toBe('BUSINESS');
    expect(canAccessBusinessFeatures({ active_role: 'BUSINESS' })).toBe(true);
    expect(canAccessAmbassadorFeatures({ active_role: 'AMBASSADOR' })).toBe(true);
  });
});

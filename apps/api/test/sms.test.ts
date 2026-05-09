import { describe, expect, it } from 'vitest';
import { normalizeUgandaPhoneNumber } from '../src/services/sms.js';

describe('Africa\'s Talking SMS helpers', () => {
  it('normalizes Uganda local numbers to E.164', () => {
    expect(normalizeUgandaPhoneNumber('0784123456')).toBe('+256784123456');
  });

  it('normalizes Uganda country-code numbers to E.164', () => {
    expect(normalizeUgandaPhoneNumber('256784123456')).toBe('+256784123456');
  });

  it('preserves valid Uganda E.164 numbers', () => {
    expect(normalizeUgandaPhoneNumber('+256784123456')).toBe(
      '+256784123456'
    );
  });

  it('rejects unsupported phone formats', () => {
    expect(normalizeUgandaPhoneNumber('+254712345678')).toBeNull();
    expect(normalizeUgandaPhoneNumber('12345')).toBeNull();
  });
});

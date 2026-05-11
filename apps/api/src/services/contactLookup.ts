function normalizeDigits(value: string) {
  return String(value ?? '').replace(/\D/g, '').trim();
}

export function normalizePhoneSearchInput(value: string) {
  return String(value ?? '').replace(/[^\d+]/g, '').trim();
}

export function buildPhoneLookupVariants(value: string) {
  const rawDigits = normalizeDigits(value);
  if (!rawDigits) {
    return [] as string[];
  }

  const variants = new Set<string>([rawDigits]);
  const nationalSignificantNumber =
    rawDigits.startsWith('256') && rawDigits.length >= 12
      ? rawDigits.slice(3)
      : rawDigits.startsWith('0') && rawDigits.length >= 10
        ? rawDigits.slice(1)
        : rawDigits.length === 9
          ? rawDigits
          : '';

  if (nationalSignificantNumber) {
    variants.add(nationalSignificantNumber);
    variants.add(`0${nationalSignificantNumber}`);
    variants.add(`256${nationalSignificantNumber}`);
  }

  return Array.from(variants).filter(Boolean);
}

export function splitSearchTerms(value: string) {
  return Array.from(
    new Set(
      String(value ?? '')
        .trim()
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ).slice(0, 5);
}

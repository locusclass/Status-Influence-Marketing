export type SupportedPaymentMethod =
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'MOBILE_MONEY';

export type MobileMoneyNetwork = 'MTN' | 'AIRTEL' | 'M-PESA';

export type FlutterwaveCheckoutProfile = {
  country: string;
  currency: 'UGX' | 'KES' | 'USD';
  phoneCountryCode: string | null;
  paymentOptions: string;
  paymentOptionsList: string[];
  supportedPaymentMethods: SupportedPaymentMethod[];
  mobileMoneyNetworks: MobileMoneyNetwork[];
  availabilityNotes: string[];
};

export function resolveAvailableFlutterwaveCheckoutProfile(
  country: string | null | undefined,
  options: {
    cardEnabled: boolean;
  }
) {
  const profile = resolveFlutterwaveCheckoutProfile(country);
  const supportedPaymentMethods = profile.supportedPaymentMethods.filter(
    (method) => method !== 'CARD' || options.cardEnabled
  );
  const availabilityNotes = [...profile.availabilityNotes];

  if (!options.cardEnabled && profile.supportedPaymentMethods.includes('CARD')) {
    availabilityNotes.push(
      'Card payments are disabled until FLUTTERWAVE_ENCRYPTION_KEY is configured on the server.'
    );
  }

  return {
    ...profile,
    supportedPaymentMethods,
    availabilityNotes,
  };
}

export function resolveFlutterwaveCheckoutProfile(
  country: string | null | undefined
): FlutterwaveCheckoutProfile {
  const normalizedCountry = String(country ?? '')
    .trim()
    .toUpperCase();

  if (normalizedCountry === 'UG') {
    return {
      country: 'UG',
      currency: 'UGX',
      phoneCountryCode: '256',
      paymentOptions: 'card,mobilemoneyuganda',
      paymentOptionsList: ['card', 'mobilemoneyuganda'],
      supportedPaymentMethods: ['CARD', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['MTN', 'AIRTEL'],
      availabilityNotes: [
        'Flutterwave v4 in Uganda supports cards and mobile money.',
      ],
    };
  }

  if (normalizedCountry === 'KE') {
    return {
      country: 'KE',
      currency: 'KES',
      phoneCountryCode: '254',
      paymentOptions: 'card,mpesa',
      paymentOptionsList: ['card', 'mpesa'],
      supportedPaymentMethods: ['CARD', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['M-PESA'],
      availabilityNotes: [
        'Flutterwave v4 in Kenya supports cards and M-Pesa.',
      ],
    };
  }

  return {
    country: normalizedCountry || 'INTL',
    currency: 'USD',
    phoneCountryCode: null,
    paymentOptions: 'card',
    paymentOptionsList: ['card'],
    supportedPaymentMethods: ['CARD'],
    mobileMoneyNetworks: [],
    availabilityNotes: [
      'Flutterwave v4 bank transfer is documented for NGN and GHS virtual accounts only, so USD checkout currently supports cards only.',
    ],
  };
}

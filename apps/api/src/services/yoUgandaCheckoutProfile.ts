export type SupportedPaymentMethod =
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'MOBILE_MONEY';

export type MobileMoneyNetwork = 'MTN' | 'AIRTEL' | 'M-PESA';

export type YoUgandaCheckoutProfile = {
  country: string;
  currency: 'UGX' | 'KES' | 'USD';
  phoneCountryCode: string | null;
  paymentOptions: string;
  paymentOptionsList: string[];
  supportedPaymentMethods: SupportedPaymentMethod[];
  mobileMoneyNetworks: MobileMoneyNetwork[];
  availabilityNotes: string[];
};

const ugandaCollectionProfile: YoUgandaCheckoutProfile = {
  country: 'UG',
  currency: 'UGX',
  phoneCountryCode: '256',
  paymentOptions: 'mobilemoneyuganda',
  paymentOptionsList: ['mobilemoneyuganda'],
  supportedPaymentMethods: ['MOBILE_MONEY'],
  mobileMoneyNetworks: ['MTN', 'AIRTEL'],
  availabilityNotes: [
    'YO Uganda supports MTN and Airtel mobile money collections in UGX.',
  ],
};

export function resolveAvailableYoUgandaCheckoutProfile(
  country: string | null | undefined,
  _options: {
    cardEnabled: boolean;
  }
) {
  return resolveYoUgandaCheckoutProfile(country);
}

export function resolveYoUgandaCheckoutProfile(
  country: string | null | undefined
): YoUgandaCheckoutProfile {
  const normalizedCountry = String(country ?? '').trim().toUpperCase();

  if (!normalizedCountry || normalizedCountry === 'UG') {
    return ugandaCollectionProfile;
  }

  return {
    ...ugandaCollectionProfile,
    availabilityNotes: [
      'YO Uganda currently routes collections through Uganda mobile money in UGX. Use an MTN or Airtel Uganda number to complete payment.',
    ],
  };
}

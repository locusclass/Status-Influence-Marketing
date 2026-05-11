const ugandaCollectionProfile = {
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
export function resolveAvailableYoUgandaCheckoutProfile(country, _options) {
    return resolveYoUgandaCheckoutProfile(country);
}
export function resolveYoUgandaCheckoutProfile(country) {
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

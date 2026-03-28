export function resolveFlutterwaveCheckoutProfile(country) {
    const normalizedCountry = String(country ?? '')
        .trim()
        .toUpperCase();
    if (normalizedCountry === 'UG') {
        return {
            country: 'UG',
            currency: 'UGX',
            paymentOptions: 'card,banktransfer,mobilemoneyuganda',
            paymentOptionsList: ['card', 'banktransfer', 'mobilemoneyuganda'],
            supportedPaymentMethods: ['CARD', 'BANK_TRANSFER', 'MOBILE_MONEY'],
            mobileMoneyNetworks: ['MTN', 'AIRTEL'],
        };
    }
    if (normalizedCountry === 'KE') {
        return {
            country: 'KE',
            currency: 'KES',
            paymentOptions: 'card,banktransfer,mpesa',
            paymentOptionsList: ['card', 'banktransfer', 'mpesa'],
            supportedPaymentMethods: ['CARD', 'BANK_TRANSFER', 'MOBILE_MONEY'],
            mobileMoneyNetworks: ['M-PESA'],
        };
    }
    return {
        country: normalizedCountry || 'INTL',
        currency: 'USD',
        paymentOptions: 'card,banktransfer',
        paymentOptionsList: ['card', 'banktransfer'],
        supportedPaymentMethods: ['CARD', 'BANK_TRANSFER'],
        mobileMoneyNetworks: [],
    };
}

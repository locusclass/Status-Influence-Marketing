import countries from 'i18n-iso-countries';
import countryToCurrency from 'country-to-currency';
countries.registerLocale((await import('i18n-iso-countries/langs/en.json', {
    assert: { type: 'json' }
})).default);
const DIAL_CODES = {
    DZ: '+213',
    AO: '+244',
    BJ: '+229',
    BW: '+267',
    BF: '+226',
    BI: '+257',
    CM: '+237',
    CV: '+238',
    CF: '+236',
    TD: '+235',
    KM: '+269',
    CD: '+243',
    CG: '+242',
    CI: '+225',
    DJ: '+253',
    EG: '+20',
    GQ: '+240',
    ER: '+291',
    SZ: '+268',
    ET: '+251',
    GA: '+241',
    GM: '+220',
    GH: '+233',
    GN: '+224',
    GW: '+245',
    KE: '+254',
    LS: '+266',
    LR: '+231',
    LY: '+218',
    MG: '+261',
    MW: '+265',
    ML: '+223',
    MR: '+222',
    MU: '+230',
    MA: '+212',
    MZ: '+258',
    NA: '+264',
    NE: '+227',
    NG: '+234',
    RW: '+250',
    ST: '+239',
    SN: '+221',
    SC: '+248',
    SL: '+232',
    SO: '+252',
    ZA: '+27',
    SS: '+211',
    SD: '+249',
    TZ: '+255',
    TG: '+228',
    TN: '+216',
    UG: '+256',
    ZM: '+260',
    ZW: '+263'
};
export function resolveCountry(input) {
    const upper = input.toUpperCase();
    const iso2 = countries.isValid(upper)
        ? upper
        : countries.getAlpha2Code(input, 'en');
    if (!iso2) {
        throw new Error('invalid_country');
    }
    const name = countries.getName(iso2, 'en') ?? iso2;
    const currency = countryToCurrency[iso2] ?? 'USD';
    const dialCode = DIAL_CODES[iso2] ?? '';
    return {
        name,
        iso2,
        dialCode,
        currency
    };
}

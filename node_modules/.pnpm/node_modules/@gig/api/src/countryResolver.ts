import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json' assert { type: 'json' };
import currencyCodes from 'currency-codes';
import metadata from 'libphonenumber-js/metadata.full.json' assert { type: 'json' };

countries.registerLocale(enLocale);

// African Union member ISO-2 codes
const AFRICAN_COUNTRIES = new Set([
  'DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD',
  'DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','CI','KE',
  'LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG',
  'RW','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'
]);

export function resolveCountryData(countryCode: string) {
  const upper = countryCode.toUpperCase();

  if (!AFRICAN_COUNTRIES.has(upper)) {
    throw new Error('Unsupported country');
  }

  const currency = currencyCodes.country(upper)?.[0]?.currency;

  if (!currency) {
    throw new Error('Currency not found for country');
  }

  const countryMeta = (metadata as any).countries?.[upper];

  if (!countryMeta || !countryMeta[0]) {
    throw new Error('Phone code not found for country');
  }

  const phoneCode = `+${countryMeta[0]}`;

  return {
    currency,
    phoneCode,
  };
}
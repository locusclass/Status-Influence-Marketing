import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import countryToCurrency from 'country-to-currency';
import metadata from 'libphonenumber-js/metadata.min.json' with { type: 'json' };

countries.registerLocale(en);

export interface ResolvedCountry {
  name: string;
  iso2: string;
  currency: string;
  dialCode: string;
}

const AFRICAN_ISO2 = [
  'DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CD','CG','CI',
  'DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR',
  'LY','MG','MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RE','RW',
  'SH','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','EH',
  'ZM','ZW'
];

export function getAllAfricanCountries(): ResolvedCountry[] {
  return AFRICAN_ISO2.map((iso2) => resolveCountry(iso2)).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export function resolveCountry(iso2: string): ResolvedCountry {
  const upper = iso2.toUpperCase();

  if (!AFRICAN_ISO2.includes(upper)) {
    throw new Error('unsupported_country');
  }

  const name = countries.getName(upper, 'en');
  if (!name) {
    throw new Error('invalid_country');
  }

  const currency = countryToCurrency[upper] ?? 'USD';

  const dialCode = getDialCode(upper);

  return {
    name,
    iso2: upper,
    currency,
    dialCode
  };
}

function getDialCode(iso2: string): string {
  const countryMeta = (metadata as any).countries[iso2];
  if (!countryMeta) return '';

  const callingCode = countryMeta[0];
  return `+${callingCode}`;
}

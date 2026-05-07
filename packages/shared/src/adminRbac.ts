export const ADMIN_MODULE_OVERVIEW = 'OVERVIEW';
export const ADMIN_MODULE_OPERATIONS = 'OPERATIONS';
export const ADMIN_MODULE_COUNTRIES = 'COUNTRIES';
export const ADMIN_MODULE_DIVISIONS = 'DIVISIONS';
export const ADMIN_MODULE_USERS = 'USERS';
export const ADMIN_MODULE_CAMPAIGNS = 'CAMPAIGNS';
export const ADMIN_MODULE_DRAFTS = 'DRAFTS';
export const ADMIN_MODULE_PROOFS = 'PROOFS';
export const ADMIN_MODULE_SESSIONS = 'SESSIONS';
export const ADMIN_MODULE_RISK = 'RISK';
export const ADMIN_MODULE_WALLETS = 'WALLETS';
export const ADMIN_MODULE_WITHDRAWALS = 'WITHDRAWALS';
export const ADMIN_MODULE_FINANCE = 'FINANCE';
export const ADMIN_MODULE_PAYOUT_REQUESTS = 'PAYOUT_REQUESTS';
export const ADMIN_MODULE_MANAGER_PAYOUTS = 'MANAGER_PAYOUTS';
export const ADMIN_MODULE_ESCROWS = 'ESCROWS';
export const ADMIN_MODULE_CONTRACTS = 'CONTRACTS';
export const ADMIN_MODULE_GATEWAY = 'GATEWAY';
export const ADMIN_MODULE_JOBS = 'JOBS';
export const ADMIN_MODULE_AUDIT_LOGS = 'AUDIT_LOGS';
export const ADMIN_MODULE_ADMIN_MANAGEMENT = 'ADMIN_MANAGEMENT';

export type AdminModuleKey =
  | typeof ADMIN_MODULE_OVERVIEW
  | typeof ADMIN_MODULE_OPERATIONS
  | typeof ADMIN_MODULE_COUNTRIES
  | typeof ADMIN_MODULE_DIVISIONS
  | typeof ADMIN_MODULE_USERS
  | typeof ADMIN_MODULE_CAMPAIGNS
  | typeof ADMIN_MODULE_DRAFTS
  | typeof ADMIN_MODULE_PROOFS
  | typeof ADMIN_MODULE_SESSIONS
  | typeof ADMIN_MODULE_RISK
  | typeof ADMIN_MODULE_WALLETS
  | typeof ADMIN_MODULE_WITHDRAWALS
  | typeof ADMIN_MODULE_FINANCE
  | typeof ADMIN_MODULE_PAYOUT_REQUESTS
  | typeof ADMIN_MODULE_MANAGER_PAYOUTS
  | typeof ADMIN_MODULE_ESCROWS
  | typeof ADMIN_MODULE_CONTRACTS
  | typeof ADMIN_MODULE_GATEWAY
  | typeof ADMIN_MODULE_JOBS
  | typeof ADMIN_MODULE_AUDIT_LOGS
  | typeof ADMIN_MODULE_ADMIN_MANAGEMENT;

export type AdminModuleDefinition = {
  key: AdminModuleKey;
  label: string;
  description: string;
  always_on?: boolean;
  super_admin_only?: boolean;
  scope_enabled?: boolean;
};

export const adminModuleDefinitions: readonly AdminModuleDefinition[] = [
  {
    key: ADMIN_MODULE_OVERVIEW,
    label: 'Overview Dashboard',
    description: 'Shared operational overview for every admin account.',
    always_on: true,
  },
  {
    key: ADMIN_MODULE_OPERATIONS,
    label: 'Operations',
    description: 'Shared live operations command center, alerts, and workforce coordination.',
    always_on: true,
  },
  {
    key: ADMIN_MODULE_COUNTRIES,
    label: 'Country Management',
    description: 'Country directory and country-level tenant controls.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_DIVISIONS,
    label: 'Division Management',
    description: 'Division directory and division-level tenant controls.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_USERS,
    label: 'User Management',
    description: 'Users, account moderation, and profile operations.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_CAMPAIGNS,
    label: 'Campaign Management',
    description: 'Campaign listing and campaign moderation.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_DRAFTS,
    label: 'Drafts',
    description: 'Campaign creation draft review.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_PROOFS,
    label: 'Verification / Proof Review',
    description: 'Proof moderation and verification review.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_SESSIONS,
    label: 'Sessions',
    description: 'Verification session monitoring.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_RISK,
    label: 'Risk',
    description: 'Trust signals and device-risk views.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_WALLETS,
    label: 'Wallets',
    description: 'Wallet balances, ledgers, and manual wallet adjustments.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_WITHDRAWALS,
    label: 'Withdrawals',
    description: 'Wallet withdrawal review and settlement tracking.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_FINANCE,
    label: 'Finance',
    description: 'Financial summary and provider transaction aggregates.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_PAYOUT_REQUESTS,
    label: 'Payout Requests',
    description: 'Payout request moderation.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_MANAGER_PAYOUTS,
    label: 'Manager Payouts',
    description: 'Tenant manager payout tracking and release actions.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_ESCROWS,
    label: 'Escrows',
    description: 'Escrow state review and moderation.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_CONTRACTS,
    label: 'Contracts',
    description: 'Contract review and moderation.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_GATEWAY,
    label: 'Gateway',
    description: 'Payment gateway transactions, webhooks, and replay tools.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_JOBS,
    label: 'Jobs',
    description: 'Worker queue inspection and retry controls.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_AUDIT_LOGS,
    label: 'Audit Logs',
    description: 'Administrative audit trail visibility.',
    scope_enabled: true,
  },
  {
    key: ADMIN_MODULE_ADMIN_MANAGEMENT,
    label: 'Admin Management',
    description: 'Create, update, scope, suspend, and delete admin accounts.',
    super_admin_only: true,
  },
] as const;

export const ALL_ADMIN_MODULE_KEYS = adminModuleDefinitions.map(
  (module) => module.key
) as readonly AdminModuleKey[];

export const ASSIGNABLE_ADMIN_MODULE_KEYS = adminModuleDefinitions
  .filter((module) => !module.always_on && !module.super_admin_only)
  .map((module) => module.key) as readonly AdminModuleKey[];

export const LEGACY_TENANT_ADMIN_MODULE_KEYS: readonly AdminModuleKey[] = [
  ADMIN_MODULE_USERS,
  ADMIN_MODULE_CAMPAIGNS,
  ADMIN_MODULE_DRAFTS,
  ADMIN_MODULE_PROOFS,
  ADMIN_MODULE_SESSIONS,
  ADMIN_MODULE_RISK,
  ADMIN_MODULE_WALLETS,
  ADMIN_MODULE_WITHDRAWALS,
  ADMIN_MODULE_FINANCE,
  ADMIN_MODULE_PAYOUT_REQUESTS,
  ADMIN_MODULE_MANAGER_PAYOUTS,
  ADMIN_MODULE_ESCROWS,
  ADMIN_MODULE_CONTRACTS,
  ADMIN_MODULE_GATEWAY,
  ADMIN_MODULE_JOBS,
  ADMIN_MODULE_AUDIT_LOGS,
] as const;

export const LEGACY_COUNTRY_ADMIN_MODULE_KEYS: readonly AdminModuleKey[] = [
  ...LEGACY_TENANT_ADMIN_MODULE_KEYS,
  ADMIN_MODULE_DIVISIONS,
] as const;

export function normalizeAdminModuleKey(value: unknown): AdminModuleKey | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return (ALL_ADMIN_MODULE_KEYS as readonly string[]).includes(normalized)
    ? (normalized as AdminModuleKey)
    : null;
}

export function isAlwaysOnAdminModule(value: unknown) {
  const normalized = normalizeAdminModuleKey(value);
  return (
    normalized === ADMIN_MODULE_OVERVIEW ||
    normalized === ADMIN_MODULE_OPERATIONS
  );
}

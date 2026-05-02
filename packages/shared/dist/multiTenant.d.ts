export declare const ADMIN_ROLE_SUPER_ADMIN = "SUPER_ADMIN";
export declare const ADMIN_ROLE_ADMIN = "ADMIN";
export declare const ADMIN_ROLE_COUNTRY_ADMIN = "COUNTRY_ADMIN";
export declare const ADMIN_ROLE_DIVISION_ADMIN = "DIVISION_ADMIN";
export declare const ADMIN_ROLE_USER = "USER";
export type AdminDashboardRole = typeof ADMIN_ROLE_SUPER_ADMIN | typeof ADMIN_ROLE_ADMIN | typeof ADMIN_ROLE_COUNTRY_ADMIN | typeof ADMIN_ROLE_DIVISION_ADMIN | typeof ADMIN_ROLE_USER;
export type RevenueBreakdown = {
    gross_amount: number;
    platform_fee: number;
    country_share: number;
    division_share: number;
    net_platform_revenue: number;
};
type QueryResultLike = {
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
};
export type DbClientLike = {
    query: (text: string, params?: unknown[]) => Promise<QueryResultLike>;
};
export declare function normalizeAdminDashboardRole(value: unknown): AdminDashboardRole;
export declare function canAccessAdminDashboard(value: unknown): boolean;
export declare function calculateRevenueBreakdown(grossAmount: number, hasDivision: boolean): RevenueBreakdown;
export declare function getMonthlyPayoutWindow(anchorDate?: Date): {
    periodStart: Date;
    periodEnd: Date;
    period_start: string;
    period_end: string;
};
export declare function recordCampaignRevenueEntry(client: DbClientLike, campaignId: string): Promise<Record<string, unknown> | null>;
export declare function generateMonthlyPayouts(client: DbClientLike, anchorDate?: Date): Promise<{
    period_start: string;
    period_end: string;
    country_admin_payouts_created: number;
    division_admin_payouts_created: number;
    wallet_credits_applied: number;
}>;
export {};

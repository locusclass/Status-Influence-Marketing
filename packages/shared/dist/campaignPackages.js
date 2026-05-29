/** Centralized pricing constants for campaign packages and marketplace listing plans. */
// Rate is authoritative in campaignPlatforms.ts; kept local here to avoid a circular import.
const PUBLIC_CONTRACT_RATE_UGX = 20;
export const CAMPAIGN_PACKAGES = [
    { code: 'STARTER', label: 'Starter', budget_ugx: 10_000, estimated_views: 500 },
    { code: 'BRONZE', label: 'Bronze', budget_ugx: 25_000, estimated_views: 1_250 },
    { code: 'SILVER', label: 'Silver', budget_ugx: 50_000, estimated_views: 2_500 },
    { code: 'GROWTH', label: 'Growth', budget_ugx: 100_000, estimated_views: 5_000 },
    { code: 'BUSINESS', label: 'Business', budget_ugx: 150_000, estimated_views: 7_500 },
    { code: 'PROFESSIONAL', label: 'Professional', budget_ugx: 250_000, estimated_views: 12_500 },
    { code: 'PREMIUM', label: 'Premium', budget_ugx: 400_000, estimated_views: 20_000 },
    { code: 'ENTERPRISE', label: 'Enterprise', budget_ugx: 600_000, estimated_views: 30_000 },
    { code: 'MARKET_LEADER', label: 'Market Leader', budget_ugx: 800_000, estimated_views: 40_000 },
    { code: 'DOMINATOR', label: 'Dominator', budget_ugx: 1_000_000, estimated_views: 50_000 },
];
export const CAMPAIGN_PACKAGE_MIN_CUSTOM_UGX = 10_000;
/** Estimated views for a custom budget. */
export function estimateViewsForBudget(budgetUgx) {
    return Math.floor(budgetUgx / PUBLIC_CONTRACT_RATE_UGX);
}
export function getCampaignPackage(code) {
    return CAMPAIGN_PACKAGES.find(p => p.code === code.trim().toUpperCase());
}
export const MARKETPLACE_LISTING_PLANS = [
    {
        code: 'BASIC',
        label: 'Basic Listing',
        price_ugx_monthly: 10_000,
        features: [
            'Business profile',
            'Product listings',
            'Contact details',
            'Appears in marketplace search',
        ],
    },
    {
        code: 'FEATURED',
        label: 'Featured Listing',
        price_ugx_monthly: 25_000,
        features: [
            'Everything in Basic',
            'Higher search ranking',
            'Featured badge',
            'More products allowed',
        ],
    },
    {
        code: 'PREMIUM',
        label: 'Premium Listing',
        price_ugx_monthly: 50_000,
        features: [
            'Everything in Featured',
            'Category & homepage exposure',
            'Priority support',
            'Analytics dashboard',
        ],
    },
    {
        code: 'MARKETPLACE_PLUS',
        label: 'Marketplace Plus',
        price_ugx_monthly: 100_000,
        features: [
            'Maximum visibility',
            'Rotating homepage & category placement',
            'Verified business badge',
            'Enhanced analytics',
        ],
    },
];
/** Monthly campaign spend threshold (UGX) that auto-grants Featured Listing benefits. */
export const FEATURED_AUTO_QUALIFY_SPEND_UGX = 100_000;
export function getMarketplaceListingPlan(code) {
    return MARKETPLACE_LISTING_PLANS.find(p => p.code === code.trim().toUpperCase());
}

/** Centralized pricing constants for campaign packages and marketplace listing plans. */
export interface CampaignPackage {
    code: string;
    label: string;
    budget_ugx: number;
    estimated_views: number;
}
export declare const CAMPAIGN_PACKAGES: CampaignPackage[];
export declare const CAMPAIGN_PACKAGE_MIN_CUSTOM_UGX = 10000;
/** Estimated views for a custom budget. */
export declare function estimateViewsForBudget(budgetUgx: number): number;
export declare function getCampaignPackage(code: string): CampaignPackage | undefined;
export interface MarketplaceListingPlan {
    code: string;
    label: string;
    price_ugx_monthly: number;
    features: string[];
}
export declare const MARKETPLACE_LISTING_PLANS: MarketplaceListingPlan[];
/** Monthly campaign spend threshold (UGX) that auto-grants Featured Listing benefits. */
export declare const FEATURED_AUTO_QUALIFY_SPEND_UGX = 100000;
export declare function getMarketplaceListingPlan(code: string): MarketplaceListingPlan | undefined;

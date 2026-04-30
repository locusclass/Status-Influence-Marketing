export declare const DEFAULT_YO_GATEWAY_BASE_URL = "http://34.79.189.141:3000/yo";
export declare const DEFAULT_YO_GATEWAY_TASK_URL = "http://34.79.189.141:3000/yo/ybs/task.php";
export declare function isDirectYoTaskUrl(value: string | null | undefined): boolean;
export declare function normalizeYoTaskUrl(configuredValue: string | null | undefined, fallback?: string, options?: {
    allowDirectHostBypass?: boolean;
}): string;
export declare function allowDirectYoHostBypass(value: string | null | undefined): boolean;
export declare function collectDirectYoTaskUrls(configuredValues: Array<string | null | undefined>): string[];

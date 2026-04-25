export interface PlatformAdapterConfig {
  platform: 'WHATSAPP_STATUS';
  roi: { x: number; y: number; width: number; height: number };
  uiHints: string[];
  viewExtraction: 'PIXEL_REGION';
}

export const platformAdapters: Record<string, PlatformAdapterConfig> = {
  WHATSAPP_STATUS: {
    platform: 'WHATSAPP_STATUS',
    roi: { x: 0.6, y: 0.78, width: 0.35, height: 0.12 },
    uiHints: ['green accent', 'status ring', 'three-dot menu'],
    viewExtraction: 'PIXEL_REGION',
  },
};

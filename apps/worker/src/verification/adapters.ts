export interface PlatformAdapterConfig {
  platform: 'WHATSAPP_STATUS' | 'TIKTOK' | 'INSTAGRAM' | 'X';
  roi: { x: number; y: number; width: number; height: number };
  uiHints: string[];
  viewExtraction: 'OCR' | 'TEMPLATE_MATCH' | 'PIXEL_REGION';
}

export const platformAdapters: Record<string, PlatformAdapterConfig> = {
  WHATSAPP_STATUS: {
    platform: 'WHATSAPP_STATUS',
    roi: { x: 0.6, y: 0.78, width: 0.35, height: 0.12 },
    uiHints: ['green accent', 'status ring', 'three-dot menu'],
    viewExtraction: 'PIXEL_REGION'
  },
  TIKTOK: {
    platform: 'TIKTOK',
    roi: { x: 0.58, y: 0.12, width: 0.38, height: 0.12 },
    uiHints: ['vertical feed', 'right-side action bar'],
    viewExtraction: 'OCR'
  },
  INSTAGRAM: {
    platform: 'INSTAGRAM',
    roi: { x: 0.62, y: 0.08, width: 0.35, height: 0.1 },
    uiHints: ['story ring', 'top bar icons'],
    viewExtraction: 'OCR'
  },
  X: {
    platform: 'X',
    roi: { x: 0.6, y: 0.2, width: 0.35, height: 0.1 },
    uiHints: ['tweet metrics row', 'bottom nav'],
    viewExtraction: 'TEMPLATE_MATCH'
  }
};

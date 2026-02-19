export type VerificationDecision = 'VERIFIED' | 'REJECTED' | 'MANUAL_REVIEW';
export type PlatformAdapter = 'WHATSAPP_STATUS' | 'TIKTOK' | 'INSTAGRAM' | 'X';

export interface VerificationChallenge {
  challenge_code: string;
  challenge_phrase: string;
  expires_at: string;
}

export interface VerificationResult {
  observed_views: number;
  observed_post_hash: string;
  challenge_seen: boolean;
  confidence: number;
  decision: VerificationDecision;
}

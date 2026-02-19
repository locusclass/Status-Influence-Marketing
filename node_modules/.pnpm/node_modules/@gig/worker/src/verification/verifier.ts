import { VerificationResult } from '@gig/shared';

export interface Verifier {
  verify(videoPath: string, campaignSpec: any, challenge: any): Promise<VerificationResult>;
}

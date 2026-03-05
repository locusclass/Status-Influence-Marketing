import { VerificationResult } from '@bakule/shared';

export type WorkerVerificationResult = VerificationResult & {
  verifier_report?: Record<string, unknown>;
};

export interface Verifier {
  verify(videoPath: string, campaignSpec: any, challenge: any): Promise<WorkerVerificationResult>;
}


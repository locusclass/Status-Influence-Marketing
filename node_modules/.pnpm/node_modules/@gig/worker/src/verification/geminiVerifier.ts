import { VerificationResult } from '@gig/shared';
import { Verifier } from './verifier.js';
import { fetch } from 'undici';

export class GeminiVerifier implements Verifier {
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl?: string, apiKey?: string) {
    this.apiUrl = apiUrl ?? process.env.GEMINI_API_URL ?? '';
    this.apiKey = apiKey ?? process.env.GEMINI_API_KEY ?? '';
  }

  async verify(videoPath: string, campaignSpec: any, challenge: any): Promise<VerificationResult> {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error('Gemini verifier not configured');
    }
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        videoPath,
        campaignSpec,
        challenge
      })
    });
    if (!res.ok) {
      throw new Error(`Gemini verifier error: ${res.status}`);
    }
    const data = (await res.json()) as VerificationResult;
    return data;
  }
}

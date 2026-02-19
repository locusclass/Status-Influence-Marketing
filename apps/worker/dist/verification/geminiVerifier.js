import { fetch } from 'undici';
export class GeminiVerifier {
    apiUrl;
    apiKey;
    constructor(apiUrl, apiKey) {
        this.apiUrl = apiUrl ?? process.env.GEMINI_API_URL ?? '';
        this.apiKey = apiKey ?? process.env.GEMINI_API_KEY ?? '';
    }
    async verify(videoPath, campaignSpec, challenge) {
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
        const data = (await res.json());
        return data;
    }
}

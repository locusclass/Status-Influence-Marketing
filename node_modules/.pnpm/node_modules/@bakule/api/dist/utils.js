import crypto from 'crypto';
import { config } from './config.js';
const WORDS = [
    'silver', 'forest', 'anchor', 'pixel', 'yellow', 'marble', 'swift', 'linen', 'copper', 'river',
    'crystal', 'meadow', 'orbit', 'valley', 'breeze', 'magnet', 'ember', 'harbor', 'violet', 'sable'
];
export function generateChallengeCode() {
    const bytes = crypto.randomBytes(4);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let out = '';
    for (let i = 0; i < 6; i += 1) {
        const byte = bytes[i % bytes.length] ?? 0;
        out += alphabet[byte % alphabet.length] ?? 'A';
    }
    return out;
}
export function generateChallengePhrase() {
    const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
    return [pick(), pick(), pick()].join(' ');
}
export function hashFingerprint(raw) {
    return crypto.createHmac('sha256', config.fingerprintPepper).update(raw).digest('hex');
}
export function signUpload(payload) {
    return crypto.createHmac('sha256', config.uploadSigningSecret).update(payload).digest('hex');
}
export function verifyUpload(payload, signature) {
    const sig = signUpload(payload);
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signature));
}
export function nowIso() {
    return new Date().toISOString();
}

import { config } from '../config.js';
function uniqueSecrets() {
    return [config.jwtSecret, ...config.jwtPreviousSecrets]
        .map((secret) => String(secret ?? '').trim())
        .filter((secret, index, list) => secret.length > 0 && list.indexOf(secret) === index);
}
export async function verifyRequestJwt(app, request) {
    const token = app.jwt.lookupToken(request);
    let lastError = null;
    for (const secret of uniqueSecrets()) {
        try {
            const decoded = app.jwt.verify(token, { key: secret });
            request.user = decoded;
            return decoded;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error('unauthorized');
}

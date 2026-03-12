import { JWT } from 'google-auth-library';
import { Readable } from 'stream';
import { config } from '../config.js';
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.full_control';
function ensureFirebaseStorageConfigured() {
    if (!config.firebase.projectId ||
        !config.firebase.clientEmail ||
        !config.firebase.privateKey ||
        !config.firebase.storageBucket) {
        throw new Error('firebase_storage_not_configured');
    }
}
function createClient() {
    ensureFirebaseStorageConfigured();
    return new JWT({
        email: config.firebase.clientEmail,
        key: config.firebase.privateKey,
        scopes: [STORAGE_SCOPE],
    });
}
async function getAccessToken() {
    const client = createClient();
    const token = await client.getAccessToken();
    if (!token?.token) {
        throw new Error('firebase_access_token_unavailable');
    }
    return token.token;
}
function objectUploadUrl(objectName) {
    const bucket = encodeURIComponent(config.firebase.storageBucket);
    const name = encodeURIComponent(objectName);
    return `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}`;
}
function objectDownloadUrl(objectName) {
    const bucket = encodeURIComponent(config.firebase.storageBucket);
    const name = encodeURIComponent(objectName);
    return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?alt=media`;
}
function objectMetadataUrl(objectName) {
    const bucket = encodeURIComponent(config.firebase.storageBucket);
    const name = encodeURIComponent(objectName);
    return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}`;
}
export async function uploadToFirebaseStorage(input) {
    const accessToken = await getAccessToken();
    const response = await fetch(objectUploadUrl(input.objectName), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': input.mimeType,
        },
        body: input.body,
        duplex: 'half',
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`firebase_storage_upload_failed:${response.status}:${detail}`);
    }
}
export async function downloadFromFirebaseStorage(input) {
    const accessToken = await getAccessToken();
    const response = await fetch(objectDownloadUrl(input.objectName), {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(input.range ? { Range: input.range } : {}),
        },
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok || !response.body) {
        const detail = await response.text();
        throw new Error(`firebase_storage_download_failed:${response.status}:${detail}`);
    }
    return {
        stream: Readable.fromWeb(response.body),
        status: response.status,
        contentLength: response.headers.get('content-length'),
        contentType: response.headers.get('content-type'),
        contentRange: response.headers.get('content-range'),
    };
}
export function extractFirebaseObjectNameFromUrl(rawUrl) {
    const value = rawUrl.trim();
    if (!value) {
        return null;
    }
    try {
        const parsed = new URL(value);
        const marker = '/uploads/files/';
        const markerIndex = parsed.pathname.indexOf(marker);
        if (markerIndex >= 0) {
            const encodedObjectName = parsed.pathname.slice(markerIndex + marker.length);
            const objectName = decodeURIComponent(encodedObjectName);
            return /^[a-zA-Z0-9._-]+$/.test(objectName) ? objectName : null;
        }
        return null;
    }
    catch {
        const marker = '/uploads/files/';
        const markerIndex = value.indexOf(marker);
        if (markerIndex < 0) {
            return null;
        }
        const [rawObjectName = ''] = value
            .slice(markerIndex + marker.length)
            .split('?');
        const encodedObjectName = rawObjectName.trim();
        if (!encodedObjectName) {
            return null;
        }
        const objectName = decodeURIComponent(encodedObjectName);
        return /^[a-zA-Z0-9._-]+$/.test(objectName) ? objectName : null;
    }
}
export async function deleteFromFirebaseStorage(objectName) {
    const accessToken = await getAccessToken();
    const response = await fetch(objectMetadataUrl(objectName), {
        method: 'DELETE',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`firebase_storage_delete_failed:${response.status}:${detail}`);
    }
    return true;
}

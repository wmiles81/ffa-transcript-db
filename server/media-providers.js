export const VIDEO_PROVIDERS = Object.freeze({
    HOTMART: 'hotmart',
    WISTIA: 'wistia',
    VIMEO: 'vimeo',
    YOUTUBE: 'youtube',
    // Renamed from 'mp4' in Phase 2 — describes hosting (self-hosted/direct mp4), not file format. No live row currently has 'mp4'.
    DIRECT: 'direct',
});

export const VALID_PROVIDERS = Object.freeze(new Set(Object.values(VIDEO_PROVIDERS)));

export function isValidProvider(p) {
    return typeof p === 'string' && VALID_PROVIDERS.has(p);
}

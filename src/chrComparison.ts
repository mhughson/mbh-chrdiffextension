import * as path from 'path';

export const CHR_SIZE = 8192;
export const CHR_WIDTH = 128;
export const CHR_HEIGHT = 256;
export const GREY_PALETTE = ['#000000', '#555555', '#AAAAAA', '#FFFFFF'];
export const CHANGED_PALETTE = ['#004400', '#008800', '#55CC55', '#AAFFAA'];

export interface ViewerIdentity {
    id: number;
    uri: string;
    scheme: string;
    filePath: string;
    query: string;
    visible: boolean;
    column: number | undefined;
}

export interface ComparisonPartner {
    partner?: number;
    reason: string;
}

function resourcePath(view: ViewerIdentity): string | undefined {
    if (view.scheme === 'file') {
        return path.normalize(view.filePath);
    }
    if (view.scheme !== 'git') {
        return undefined;
    }
    let params: unknown;
    try {
        params = JSON.parse(view.query);
    } catch {
        return undefined;
    }
    if (!params || typeof params !== 'object' || !('path' in params) ||
        typeof params.path !== 'string' || !('ref' in params) || typeof params.ref !== 'string' ||
        'submoduleOf' in params || path.normalize(params.path) !== path.normalize(view.filePath)) {
        return undefined;
    }
    return path.normalize(params.path);
}

export function findComparisonPartner(view: ViewerIdentity, views: readonly ViewerIdentity[]): ComparisonPartner {
    if (!view.visible || view.column === undefined) {
        return { reason: 'Preview: no visible comparison.' };
    }
    const candidates = views.filter(other => other.visible && other.column === view.column);
    if (candidates.length !== 2) {
        return { reason: candidates.length > 2
            ? 'Comparison unavailable: ambiguous viewers in this editor group.'
            : 'Preview: no detected comparison.' };
    }
    const other = candidates.find(candidate => candidate.id !== view.id);
    if (!other || other.uri === view.uri) {
        return { reason: 'Comparison unavailable: identical resources.' };
    }
    const ownPath = resourcePath(view);
    const otherPath = resourcePath(other);
    if (!ownPath || !otherPath) {
        return { reason: 'Comparison unavailable: unsupported resource or Git URI.' };
    }
    if (ownPath !== otherPath || (view.scheme !== 'git' && other.scheme !== 'git')) {
        return { reason: 'Comparison unavailable: not a same-path Git comparison.' };
    }
    return { partner: other.id, reason: 'Git comparison (inferred from visible viewers)' };
}

export function compareChr(a: Uint8Array, b: Uint8Array): { mask: number[]; changedPixels: number } {
    for (const data of [a, b]) {
        if (data.length > CHR_SIZE || data.length % 16 !== 0) {
            throw new Error('Comparison supports complete 16-byte tiles up to 8192 bytes per file.');
        }
    }
    const mask = new Array<number>(CHR_WIDTH * CHR_HEIGHT).fill(0);
    let changedPixels = 0;
    for (let tile = 0; tile < Math.max(a.length, b.length) / 16; tile++) {
        const offset = tile * 16;
        const missing = offset >= a.length || offset >= b.length;
        for (let row = 0; row < 8; row++) {
            const bits = missing ? 255 :
                (a[offset + row] ^ b[offset + row]) | (a[offset + row + 8] ^ b[offset + row + 8]);
            for (let col = 0; col < 8; col++) {
                if (bits & (128 >> col)) {
                    mask[(Math.floor(tile / 16) * 8 + row) * CHR_WIDTH + (tile % 16) * 8 + col] = 1;
                    changedPixels++;
                }
            }
        }
    }
    return { mask, changedPixels };
}

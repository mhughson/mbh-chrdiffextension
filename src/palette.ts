import { CHANGED_PALETTE, GREY_PALETTE } from './chrComparison';

export const CONFIG_SECTION = 'nes-chr-diff-viewer';

export interface Palettes {
    palette: string[];
    changedPalette: string[];
}

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Palettes are embedded in the webview script, so only well-formed hex colors are accepted.
export function sanitizePalette(value: unknown, fallback: readonly string[]): string[] {
    return Array.isArray(value) && value.length === 4 && value.every(color => typeof color === 'string' && COLOR.test(color))
        ? [...value]
        : [...fallback];
}

export function readPalettes(config: { get(key: string): unknown }): Palettes {
    return {
        palette: sanitizePalette(config.get('palette'), GREY_PALETTE),
        changedPalette: sanitizePalette(config.get('changedPalette'), CHANGED_PALETTE)
    };
}

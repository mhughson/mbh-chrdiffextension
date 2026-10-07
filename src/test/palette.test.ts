import * as assert from 'assert';
import { CHANGED_PALETTE, GREY_PALETTE } from '../chrComparison';
import { readPalettes, sanitizePalette } from '../palette';

suite('Palette settings', () => {
    test('accepts four hex colors in any supported form', () => {
        const colors = ['#000', '#12AB34', '#abcdef', '#FFFFFF80'];
        assert.deepStrictEqual(sanitizePalette(colors, GREY_PALETTE), colors);
    });

    test('rejects anything else and returns a copy of the fallback', () => {
        for (const value of [undefined, null, 'red', [], ['#000', '#111', '#222'], ['#000', '#111', '#222', '#333', '#444'],
            ['#000', '#111', '#222', 'red'], ['#000', '#111', '#222', '#12345'], ['#000', '#111', '#222', 7],
            ['#000', '#111', '#222', '#333"</script>']]) {
            const result = sanitizePalette(value, GREY_PALETTE);
            assert.deepStrictEqual(result, GREY_PALETTE, JSON.stringify(value));
            assert.notStrictEqual(result, GREY_PALETTE);
        }
    });

    test('reads both palettes independently', () => {
        const custom = ['#111', '#222', '#333', '#444'];
        const values: Record<string, unknown> = { palette: custom, changedPalette: ['bad'] };
        assert.deepStrictEqual(readPalettes({ get: key => values[key] }), { palette: custom, changedPalette: CHANGED_PALETTE });
        assert.deepStrictEqual(readPalettes({ get: () => undefined }), { palette: GREY_PALETTE, changedPalette: CHANGED_PALETTE });
    });
});
import * as assert from 'assert';
import * as path from 'path';
import { CHR_SIZE, compareChr, findComparisonPartner, ViewerIdentity } from '../chrComparison';

suite('CHR pixel comparison', () => {
    test('identical files have no changed pixels', () => {
        const result = compareChr(new Uint8Array(CHR_SIZE), new Uint8Array(CHR_SIZE));
        assert.strictEqual(result.changedPixels, 0);
        assert.strictEqual(result.mask.length, 128 * 256);
        assert.ok(result.mask.every(value => value === 0));
    });

    test('both bitplanes and both ends of a row map to exact canvas pixels', () => {
        const original = new Uint8Array(CHR_SIZE);
        const modified = new Uint8Array(original);
        modified[0] = 128;
        modified[8] = 1;
        modified[16 * 17 + 7] = 128;
        modified[CHR_SIZE - 1] = 1;
        const result = compareChr(original, modified);
        assert.strictEqual(result.changedPixels, 4);
        assert.deepStrictEqual(result.mask.flatMap((value, index) => value ? [index] : []),
            [0, 7, 15 * 128 + 8, 256 * 128 - 1]);
        assert.deepStrictEqual(compareChr(modified, original), result);
    });

    test('changing both bitplanes counts one pixel, even when becoming black', () => {
        const original = new Uint8Array(16);
        original[0] = original[8] = 128;
        const result = compareChr(original, new Uint8Array(16));
        assert.strictEqual(result.changedPixels, 1);
        assert.strictEqual(result.mask[0], 1);
    });

    test('added and removed zero-filled tiles are changes, not padding', () => {
        const result = compareChr(new Uint8Array(16), new Uint8Array(32));
        assert.strictEqual(result.changedPixels, 64);
        assert.strictEqual(result.mask[8], 1);
        assert.strictEqual(result.mask[0], 0);
        assert.deepStrictEqual(compareChr(new Uint8Array(32), new Uint8Array(16)), result);
    });

    test('empty files and unsupported sizes are explicit', () => {
        assert.strictEqual(compareChr(new Uint8Array(), new Uint8Array()).changedPixels, 0);
        assert.strictEqual(compareChr(new Uint8Array(), new Uint8Array(16)).changedPixels, 64);
        assert.throws(() => compareChr(new Uint8Array(17), new Uint8Array(16)), /complete 16-byte tiles/);
        assert.throws(() => compareChr(new Uint8Array(CHR_SIZE + 16), new Uint8Array(16)), /8192/);
    });
});

suite('Conservative viewer pairing', () => {
    const filePath = path.resolve('pairing.chr');
    function view(id: number, scheme: string, ref = 'HEAD', column = 1): ViewerIdentity {
        return {
            id, scheme, filePath, column, visible: true,
            uri: `${scheme}:${filePath}?${ref}`,
            query: scheme === 'git' ? JSON.stringify({ path: filePath, ref }) : ''
        };
    }

    test('pairs working tree/index and staged/historical Git resources symmetrically', () => {
        for (const pair of [
            [view(1, 'git', '~'), view(2, 'file')],
            [view(1, 'git', 'HEAD'), view(2, 'git', '')],
            [view(1, 'git', 'abc123'), view(2, 'git', 'def456')]
        ]) {
            assert.strictEqual(findComparisonPartner(pair[0], pair).partner, 2);
            assert.strictEqual(findComparisonPartner(pair[1], pair).partner, 1);
        }
    });

    test('does not pair ordinary previews or different editor groups', () => {
        const a = view(1, 'file');
        assert.strictEqual(findComparisonPartner(a, [a]).partner, undefined);
        const b = view(2, 'git', 'HEAD', 2);
        assert.strictEqual(findComparisonPartner(a, [a, b]).partner, undefined);
        assert.strictEqual(findComparisonPartner(a, [a, view(2, 'file', 'other')]).partner, undefined);
    });

    test('rejects ambiguity, hidden peers, unknown groups and identical resources', () => {
        const a = view(1, 'git');
        const b = view(2, 'file');
        assert.match(findComparisonPartner(a, [a, b, view(3, 'git', '')]).reason, /ambiguous/);
        assert.strictEqual(findComparisonPartner(a, [a, { ...b, visible: false }]).partner, undefined);
        assert.strictEqual(findComparisonPartner({ ...a, column: undefined }, [a, b]).partner, undefined);
        assert.strictEqual(findComparisonPartner(a, [a, view(2, 'git')]).partner, undefined);
    });

    test('different paths, malformed Git URIs, submodules and unsupported schemes never pair', () => {
        const a = view(1, 'git');
        for (const other of [
            { ...view(2, 'file'), filePath: path.resolve('other.chr') },
            { ...view(2, 'git', ''), query: 'invalid' },
            { ...view(2, 'git', ''), query: JSON.stringify({ path: filePath, ref: 1 }) },
            { ...view(2, 'git', ''), query: JSON.stringify({ path: 'different.chr', ref: '' }) },
            { ...view(2, 'git', ''), query: JSON.stringify({ path: filePath, ref: '', submoduleOf: 'repo' }) },
            view(2, 'custom')
        ]) {
            assert.strictEqual(findComparisonPartner(a, [a, other]).partner, undefined);
        }
    });
});

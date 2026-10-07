import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { CHANGED_PALETTE, GREY_PALETTE, compareChr } from '../chrComparison';
import { NESChrDiffProvider } from '../nesChrDiffProvider';

suite('Actual webview rendering script', () => {
    test('grayscale defaults, green changed pixels, toggle messages, zoom and error recovery', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chr-render-test-'));
        const uri = vscode.Uri.file(path.join(directory, 'fixture.chr'));
        const provider = new NESChrDiffProvider();
        const cancellation = new vscode.CancellationTokenSource();
        const panel = vscode.window.createWebviewPanel('chr-render-test', 'CHR rendering test', vscode.ViewColumn.One, {});
        try {
            await fs.writeFile(uri.fsPath, new Uint8Array(8192));
            const document = await provider.openCustomDocument(uri,
                { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
            await provider.resolveCustomEditor(document, panel, cancellation.token);
            const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)?.[1];
            assert.ok(script, 'Use the production script, not a copy of the rendering logic.');
            const painted = new Map<string, string>();
            const canvasEvents = new Map<string, (event: { deltaY: number; preventDefault(): void }) => void>();
            const context = {
                fillStyle: '',
                clearRect() { painted.clear(); },
                fillRect(x: number, y: number) { painted.set(`${x},${y}`, this.fillStyle); }
            };
            const canvas = {
                width: 512, height: 1024,
                getContext: () => context,
                addEventListener: (name: string, callback: (event: { deltaY: number; preventDefault(): void }) => void) =>
                    canvasEvents.set(name, callback)
            };
            const status = { textContent: '' };
            const toggleLabel = { title: '', hidden: true };
            const button = { addEventListener() {} };
            let toggleChanged: (() => void) | undefined;
            const toggle = {
                checked: false, disabled: true,
                addEventListener(name: string, callback: () => void) { toggleChanged = callback; }
            };
            const messages: object[] = [];
            let receive: ((event: { data: object }) => void) | undefined;
            vm.runInNewContext(script, {
                document: {
                    getElementById: (id: string) => id === 'chrCanvas' ? canvas :
                        id === 'comparisonStatus' ? status : id === 'showChanges' ? toggle :
                        id === 'showChangesLabel' ? toggleLabel : button
                },
                window: {
                    addEventListener: (name: string, callback: (event: { data: object }) => void) => { receive = callback; }
                },
                acquireVsCodeApi: () => ({ postMessage(message: object) { messages.push(message); } }),
                setTimeout() {}
            });
            assert.ok(receive);
            const send = (data: object) => receive?.({ data });
            const original = new Uint8Array(32);
            original[0] = 0b10110000;
            original[8] = 0b11010000;
            original[16] = 128;
            const modified = new Uint8Array(32);
            const comparison = compareChr(original, modified);
            assert.strictEqual(comparison.changedPixels, 5);
            send({ type: 'init', data: Array.from(original) });
            const comparisonMessage = {
                type: 'comparison', mask: comparison.mask, status: '5 changed pixels',
                available: true, showChanges: false
            };
            send(comparisonMessage);
            assert.strictEqual(painted.get('0,0'), GREY_PALETTE[3]);
            assert.strictEqual(painted.get('4,0'), GREY_PALETTE[2]);
            assert.strictEqual(painted.get('8,0'), GREY_PALETTE[1]);
            assert.strictEqual(painted.get('16,0'), GREY_PALETTE[0]);
            assert.strictEqual(painted.get('32,0'), GREY_PALETTE[1]);
            assert.strictEqual(status.textContent, '5 changed pixels');
            assert.strictEqual(toggleLabel.title, 'Show changes \u2014 5 changed pixels', 'Status is shown as the icon tooltip.');
            assert.ok([...painted.values()].every(color => GREY_PALETTE.includes(color)));
            assert.strictEqual(toggle.disabled, false);
            assert.strictEqual(toggleLabel.hidden, false, 'The toggle appears once a diff is detected.');
            toggle.checked = true;
            toggleChanged?.();
            assert.strictEqual(JSON.stringify(messages.pop()), JSON.stringify({ type: 'showChanges', enabled: true, request: 1 }));
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[3], 'A click repaints immediately.');
            send({ ...comparisonMessage, showChanges: false, toggleRequest: 0 });
            assert.strictEqual(toggle.checked, true, 'A message sent before the click cannot revert it.');
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[3]);
            send({ ...comparisonMessage, showChanges: true, toggleRequest: 1 });
            assert.strictEqual(toggle.checked, true);
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[3]);
            assert.strictEqual(painted.get('4,0'), CHANGED_PALETTE[2]);
            assert.strictEqual(painted.get('8,0'), CHANGED_PALETTE[1]);
            assert.strictEqual(painted.get('16,0'), GREY_PALETTE[0]);
            assert.strictEqual(painted.get('32,0'), CHANGED_PALETTE[1]);
            assert.strictEqual([...painted.values()].filter(color => CHANGED_PALETTE.includes(color)).length, 5);

            send({ ...comparisonMessage, showChanges: true, toggleRequest: 1, data: Array.from(modified) });
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[0], 'Changes to black remain visibly green.');
            let prevented = false;
            canvasEvents.get('wheel')?.({ deltaY: -1, preventDefault() { prevented = true; } });
            assert.ok(prevented);
            assert.ok(canvas.width > 512);
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[0]);
            assert.strictEqual(painted.get('4.4,0'), CHANGED_PALETTE[0], 'Highlighting scales with pixels.');
            const zoomedWidth = canvas.width;
            send({ ...comparisonMessage, showChanges: false, toggleRequest: 1 });
            assert.ok([...painted.values()].every(color => GREY_PALETTE.includes(color)));
            assert.strictEqual(toggle.checked, false);
            send({ type: 'comparison', mask: [], status: 'Preview', available: false, showChanges: true, toggleRequest: 1 });
            assert.strictEqual(toggle.disabled, true);
            assert.strictEqual(toggleLabel.hidden, true, 'A non-diff viewer hides the toggle.');
            assert.ok([...painted.values()].every(color => GREY_PALETTE.includes(color)),
                'Unavailable comparison never highlights pixels.');
            assert.strictEqual(painted.get('0,0'), GREY_PALETTE[0]);
            assert.strictEqual(canvas.width, zoomedWidth, 'Comparison updates do not reset zoom.');

            send({ type: 'update', data: Array.from(original) });
            send({ type: 'update', data: Array.from(new Uint8Array(16)) });
            assert.ok([...painted.values()].every(color => color === GREY_PALETTE[0]),
                'Shrinking a file clears bytes left over from its old length.');
            send({ type: 'error', message: 'File unavailable' });
            assert.strictEqual(painted.size, 0);
            assert.strictEqual(status.textContent, 'File unavailable');
            assert.strictEqual(toggle.disabled, true);
            assert.strictEqual(toggleLabel.hidden, true);
            send({ type: 'update', data: Array.from(original) });
            assert.strictEqual(painted.get('0,0'), GREY_PALETTE[3], 'Recovery does not retain the old mask.');
        } finally {
            panel.dispose();
            provider.dispose();
            cancellation.dispose();
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});

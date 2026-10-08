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
            type InputEvent = Partial<{ deltaX: number; deltaY: number; ctrlKey: boolean; altKey: boolean; button: number;
                key: string; clientX: number; clientY: number; data: object }>;
            type Handler = (event: InputEvent & { preventDefault(): void; stopPropagation(): void }) => void;
            const canvasEvents = new Map<string, Handler>();
            const viewportEvents = new Map<string, Handler>();
            const context = {
                fillStyle: '',
                clearRect() { painted.clear(); },
                fillRect(x: number, y: number) { painted.set(`${x},${y}`, this.fillStyle); }
            };
            const canvas = {
                width: 512, height: 1024,
                getContext: () => context,
                style: { cursor: '' },
                // The canvas sits at (10, 40) in the panel, moved by the viewport scroll.
                getBoundingClientRect: () => ({ left: 10 - viewport.scrollLeft, top: 40 - viewport.scrollTop }),
                addEventListener: (name: string, callback: Handler) => canvasEvents.set(name, callback)
            };
            const status = { textContent: '' };
            const toggleLabel = { title: '', hidden: true };
            const viewport = {
                clientWidth: 514, clientHeight: 1026, scrollLeft: 0, scrollTop: 0,
                addEventListener: (name: string, callback: Handler) => viewportEvents.set(name, callback)
            };
            // Dispatches like the browser: canvas listeners first, then the viewport (bubbling).
            const fire = (target: 'canvas' | 'viewport' | 'window', name: string, event: InputEvent = {}) => {
                const result = { prevented: false, stopped: false };
                const full = {
                    ...event, preventDefault() { result.prevented = true; }, stopPropagation() { result.stopped = true; }
                };
                if (target === 'canvas') {
                    canvasEvents.get(name)?.(full);
                }
                (target === 'window' ? windowEvents : viewportEvents).get(name)?.(full);
                return result;
            };
            const makeButton = () => {
                const classes = new Set<string>();
                const attributes = new Map<string, string>();
                let click: (() => void) | undefined;
                return {
                    classes, attributes, click: () => click?.(),
                    classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) },
                    setAttribute: (name: string, value: string) => attributes.set(name, value),
                    addEventListener: (name: string, callback: () => void) => { click = callback; }
                };
            };
            const fitButton = makeButton();
            const fillButton = makeButton();
            const settingsButton = makeButton();
            const spriteButton = makeButton();
            const cssVariables = new Map<string, string>();
            const windowEvents = new Map<string, Handler>();
            let toggleChanged: (() => void) | undefined;
            const toggle = {
                checked: false, disabled: true,
                addEventListener(name: string, callback: () => void) { toggleChanged = callback; }
            };
            const messages: object[] = [];
            let receive: ((event: { data: object }) => void) | undefined;
            vm.runInNewContext(script, {
                document: {
                    getElementById: (id: string) => ({
                        chrCanvas: canvas, comparisonStatus: status, showChanges: toggle,
                        showChangesLabel: toggleLabel, viewport, zoomFit: fitButton, zoomFill: fillButton,
                        openSettings: settingsButton, view8x16: spriteButton
                    } as Record<string, unknown>)[id],
                    documentElement: { style: { setProperty: (name: string, value: string) => cssVariables.set(name, value) } }
                },
                window: {
                    addEventListener: (name: string, callback: Handler) => {
                        windowEvents.set(name, callback);
                        if (name === 'message') {
                            receive = callback as (event: { data: object }) => void;
                        }
                    }
                },
                acquireVsCodeApi: () => ({ postMessage(message: object) { messages.push(message); } }),
                setTimeout() {}
            });
            assert.ok(receive);
            assert.strictEqual(canvas.width, 512, 'Zoom to fit is the default.');
            assert.strictEqual(canvas.height, 1024);
            assert.ok(fitButton.classes.has('active'));
            assert.strictEqual(fitButton.attributes.get('aria-pressed'), 'true');
            assert.strictEqual(fillButton.attributes.get('aria-pressed'), 'false');
            assert.strictEqual(cssVariables.get('--changed-background'), CHANGED_PALETTE[1]);
            assert.strictEqual(cssVariables.get('--changed-border'), CHANGED_PALETTE[2]);
            settingsButton.click();
            assert.strictEqual(JSON.stringify(messages.pop()), JSON.stringify({ type: 'openSettings' }));
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

            spriteButton.click();
            assert.strictEqual(JSON.stringify(messages.pop()), JSON.stringify({ type: 'spriteMode', enabled: true, request: 1 }));
            send({ type: 'spriteMode', enabled: false, request: 0 });
            assert.ok(spriteButton.classes.has('active'));
            assert.strictEqual(spriteButton.attributes.get('aria-pressed'), 'true');
            send({ type: 'spriteMode', enabled: true, request: 1 });
            assert.strictEqual(painted.get('0,32'), CHANGED_PALETTE[1], 'Odd tile is the bottom half of the sprite.');
            assert.strictEqual(painted.get('32,0'), GREY_PALETTE[0], 'The next sprite starts with tile 2, not tile 1.');
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[3]);
            assert.strictEqual([...painted.values()].filter(color => CHANGED_PALETTE.includes(color)).length, 5,
                'Highlighting follows source pixels rather than rearranged display coordinates.');
            assert.strictEqual(canvas.width, 512);
            assert.strictEqual(canvas.height, 1024);
            assert.ok(fitButton.classes.has('active'), 'Changing layout preserves zoom mode.');
            const spriteFixture = new Uint8Array(8192);
            for (const tile of [15, 16, 31, 32, 255, 256, 511]) {
                spriteFixture[tile * 16] = 128;
            }
            send({ type: 'comparison', data: Array.from(spriteFixture), mask: [], available: false, status: 'Preview' });
            for (const [x, y] of [[224, 32], [256, 0], [480, 32], [0, 64], [480, 480], [0, 512], [480, 992]]) {
                assert.strictEqual(painted.get(`${x},${y}`), GREY_PALETTE[1],
                    'Pairs are row-major, with separate 4 KB pattern tables and the final odd tile at the bottom.');
            }
            spriteButton.click();
            assert.strictEqual(JSON.stringify(messages.pop()), JSON.stringify({ type: 'spriteMode', enabled: false, request: 2 }));
            assert.ok(!spriteButton.classes.has('active'));
            assert.strictEqual(spriteButton.attributes.get('aria-pressed'), 'false');
            assert.strictEqual(painted.get('480,0'), GREY_PALETTE[1], '8x8 view restores the source tile order.');
            assert.strictEqual(painted.get('0,32'), GREY_PALETTE[1]);
            send({ type: 'spriteMode', enabled: true, request: 2 });
            assert.ok(spriteButton.classes.has('active'), 'The partner toggle updates this viewer.');
            assert.strictEqual(painted.get('224,32'), GREY_PALETTE[1], 'A host layout message repaints the tiles.');
            send({ type: 'spriteMode', enabled: false, request: 2 });
            send({ ...comparisonMessage, data: Array.from(original), showChanges: true, toggleRequest: 1 });

            send({ ...comparisonMessage, showChanges: true, toggleRequest: 1, data: Array.from(modified) });
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[0], 'Changes to black remain visibly green.');
            assert.ok(!fire('canvas', 'wheel', { deltaY: -1, clientX: 51, clientY: 121 }).prevented, 'A plain wheel scrolls.');
            assert.strictEqual(canvas.width, 512);
            assert.ok(!fire('canvas', 'wheel', { deltaY: -1, ctrlKey: true, clientX: 51, clientY: 121 }).prevented);
            assert.strictEqual(canvas.width, 512, 'Ctrl+wheel is not a zoom gesture.');
            assert.ok(fire('canvas', 'wheel', { deltaY: -1, altKey: true, clientX: 51, clientY: 121 }).prevented);
            assert.strictEqual(canvas.width, 563, 'Alt+wheel zooms in by 10%.');
            assert.strictEqual(canvas.style.cursor, 'zoom-out', 'Alt state is read from the wheel event.');
            // Image pixel (10, 20) was under the mouse at scale 4 and stays there at scale 4.4.
            assert.ok(Math.abs(viewport.scrollLeft - (11 + 10 * 4.4 - 51)) < 1e-9);
            assert.ok(Math.abs(viewport.scrollTop - (41 + 20 * 4.4 - 121)) < 1e-9);
            assert.strictEqual(painted.get('0,0'), CHANGED_PALETTE[0]);
            assert.strictEqual(painted.get('4,0'), CHANGED_PALETTE[0], 'Highlighting scales with pixels.');
            assert.ok(!fitButton.classes.has('active') && !fillButton.classes.has('active'), 'Wheel zoom is manual.');
            const zoomedWidth = canvas.width;
            viewport.clientWidth = 258;
            fire('window', 'resize');
            assert.strictEqual(canvas.width, zoomedWidth, 'Resizing keeps a manual zoom.');
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
            fitButton.click();
            assert.strictEqual(canvas.width, 256, 'Fit uses the smaller axis (width here).');
            assert.strictEqual(canvas.height, 512);
            assert.ok(fitButton.classes.has('active'));
            fillButton.click();
            assert.strictEqual(canvas.width, 512, 'Fill uses the larger axis (height here).');
            assert.strictEqual(canvas.height, 1024);
            assert.ok(fillButton.classes.has('active') && !fitButton.classes.has('active'));
            assert.strictEqual(fillButton.attributes.get('aria-pressed'), 'true');
            viewport.clientWidth = 514;
            viewport.clientHeight = 514;
            fire('window', 'resize');
            assert.strictEqual(canvas.width, 512, 'Fill follows the panel size.');
            fitButton.click();
            assert.strictEqual(canvas.width, 256);
            assert.strictEqual(painted.get('2,0'), GREY_PALETTE[2], 'Fractional zoom keeps whole-pixel edges.');
            viewport.clientWidth = 514;
            viewport.clientHeight = 1026;
            fire('window', 'resize');
            assert.strictEqual(canvas.width, 512, 'Fit follows the panel size.');

            viewport.scrollLeft = 0;
            viewport.scrollTop = 0;
            const imagePoint = (x: number, y: number) => {
                const rect = canvas.getBoundingClientRect();
                return [(x - rect.left - 1) / (canvas.width / 128), (y - rect.top - 1) / (canvas.height / 256)];
            };
            fire('viewport', 'pointermove', { altKey: false, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.style.cursor, 'zoom-in');
            assert.ok(fire('canvas', 'pointerdown', { button: 0, clientX: 51, clientY: 121 }).prevented);
            assert.strictEqual(canvas.width, 1024, 'Click zooms in.');
            assert.deepStrictEqual(imagePoint(51, 121), [10, 20], 'The clicked pixel stays under the mouse.');
            assert.ok(!fitButton.classes.has('active'), 'Click zoom is manual.');
            fire('canvas', 'pointerdown', { button: 2, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.width, 1024, 'Only the left button zooms.');
            fire('window', 'keydown', { key: 'Alt' });
            assert.strictEqual(canvas.style.cursor, 'zoom-out');
            fire('canvas', 'pointerdown', { button: 0, altKey: true, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.width, 512, 'Alt+click zooms out.');
            assert.deepStrictEqual(imagePoint(51, 121), [10, 20]);
            assert.ok(fire('window', 'keyup', { key: 'Alt' }).stopped,
                'The Alt release ending an Alt+click is not forwarded, so it cannot focus the menu bar.');
            assert.strictEqual(canvas.style.cursor, 'zoom-in');
            fire('window', 'keydown', { key: 'Alt' });
            assert.ok(!fire('window', 'keyup', { key: 'Alt' }).stopped, 'A lone Alt press still reaches VS Code.');
            fire('viewport', 'pointermove', { altKey: true, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.style.cursor, 'zoom-out', 'Alt held before entering the panel is detected.');
            fire('viewport', 'pointermove', { altKey: false, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.style.cursor, 'zoom-in');

            fire('window', 'keydown', { key: 'Alt' });
            fire('canvas', 'wheel', { deltaY: 1, altKey: true, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.width, 465, 'Alt+wheel down zooms out.');
            assert.ok(fire('window', 'keyup', { key: 'Alt' }).stopped, 'Alt+wheel does not focus the menu bar either.');
            fire('canvas', 'wheel', { deltaX: -1, altKey: true, clientX: 51, clientY: 121 });
            assert.strictEqual(canvas.width, 512, 'Alt+wheel reported as horizontal scrolling still zooms.');
            fire('viewport', 'pointerover', { altKey: true });
            assert.strictEqual(canvas.style.cursor, 'zoom-out', 'Entering with Alt held shows the zoom-out cursor.');
            fire('window', 'blur');
            assert.strictEqual(canvas.style.cursor, 'zoom-in', 'Losing focus forgets Alt.');
            fire('window', 'keydown', { key: ' ' });
            assert.strictEqual(canvas.style.cursor, 'zoom-in', 'Space has no special meaning.');
            const customPalette = ['#112233', '#445566', '#778899', '#AABBCC'];
            const customChanged = ['#330000', '#660000', '#990000', '#CC0000'];
            send({ type: 'palette', palette: customPalette, changedPalette: customChanged });
            assert.strictEqual(painted.get('0,0'), customPalette[3], 'Palette changes repaint immediately.');
            assert.strictEqual(cssVariables.get('--changed-background'), customChanged[1]);
            assert.strictEqual(cssVariables.get('--changed-border'), customChanged[2]);
            send({ ...comparisonMessage, showChanges: true, toggleRequest: 1 });
            assert.strictEqual(painted.get('0,0'), customChanged[3]);
            assert.strictEqual(painted.get('16,0'), customPalette[0]);
            send({ type: 'palette', palette: GREY_PALETTE, changedPalette: CHANGED_PALETTE });
            send({ type: 'comparison', mask: [], status: 'Preview', available: false, showChanges: true, toggleRequest: 1 });

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

    test('color settings reach open viewers and invalid values fall back to defaults', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chr-palette-test-'));
        const uri = vscode.Uri.file(path.join(directory, 'fixture.chr'));
        const provider = new NESChrDiffProvider();
        const cancellation = new vscode.CancellationTokenSource();
        const panel = vscode.window.createWebviewPanel('chr-palette-test', 'CHR palette test', vscode.ViewColumn.One, {});
        const emitter = new vscode.EventEmitter<unknown>();
        const config = vscode.workspace.getConfiguration('nes-chr-diff-viewer');
        const received: { type: string; palette?: string[]; changedPalette?: string[] }[] = [];
        const webview = new Proxy(panel.webview, {
            get(target, property) {
                if (property === 'onDidReceiveMessage') {
                    return emitter.event;
                }
                if (property === 'postMessage') {
                    return (message: { type: string }) => { received.push(message); return Promise.resolve(true); };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set: (target, property, value) => Reflect.set(target, property, value, target)
        });
        const wrapper = new Proxy(panel, {
            get(target, property) {
                if (property === 'webview') {
                    return webview;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const lastPalette = () => [...received].reverse().find(message => message.type === 'palette');
        const waitForPalette = async (expected: string[]) => {
            for (let attempt = 0; attempt < 100 && JSON.stringify(lastPalette()?.palette) !== JSON.stringify(expected); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.deepStrictEqual(lastPalette()?.palette, expected);
        };
        try {
            await fs.writeFile(uri.fsPath, new Uint8Array(8192));
            const document = await provider.openCustomDocument(uri,
                { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
            await provider.resolveCustomEditor(document, wrapper, cancellation.token);
            assert.ok(panel.webview.html.includes(JSON.stringify(GREY_PALETTE)), 'Defaults are embedded in the page.');
            emitter.fire({ type: 'ready' });
            assert.deepStrictEqual(lastPalette(), { type: 'palette', palette: GREY_PALETTE, changedPalette: CHANGED_PALETTE });

            const custom = ['#123', '#456789', '#abcdef', '#ABCDEF80'];
            await config.update('palette', custom, vscode.ConfigurationTarget.Global);
            await waitForPalette(custom);
            assert.deepStrictEqual(lastPalette()?.changedPalette, CHANGED_PALETTE);

            await config.update('palette', ['#000000', 'red;</script>', '#AAAAAA', '#FFFFFF'], vscode.ConfigurationTarget.Global);
            await waitForPalette(GREY_PALETTE);
        } finally {
            await config.update('palette', undefined, vscode.ConfigurationTarget.Global);
            emitter.dispose();
            panel.dispose();
            provider.dispose();
            cancellation.dispose();
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});

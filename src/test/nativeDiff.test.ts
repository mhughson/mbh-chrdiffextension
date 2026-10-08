import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { activate } from '../extension';
import { NESChrDiffProvider } from '../nesChrDiffProvider';

const exec = promisify(execFile);
type ExtensionApi = ReturnType<typeof activate>;

interface GitExtension {
    getAPI(version: 1): {
        openRepository(uri: vscode.Uri): Promise<{ status(): Promise<void> } | null>;
    };
}

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            assert.fail(describe());
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

suite('Native VS Code Git diff integration', function () {
    this.timeout(60000);
    let directory: string;
    let uri: vscode.Uri;
    let api: ExtensionApi;
    let repository: { status(): Promise<void> } | null;
    let previousParentSetting: string | undefined;

    async function git(...args: string[]) {
        return (await exec('git', ['-C', directory, ...args])).stdout.trim();
    }

    async function stageTwoPixels() {
        const staged = new Uint8Array(8192);
        staged[0] = 128;
        staged[8] = 1;
        await fs.writeFile(uri.fsPath, staged);
        await git('add', 'fixture.chr');
        const working = new Uint8Array(8192);
        working[0] = 255;
        await fs.writeFile(uri.fsPath, working);
    }

    async function commitStagedPixels() {
        await stageTwoPixels();
        await git('-c', 'user.name=CHR Tests', '-c', 'user.email=chr-tests@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-m', 'CHR staged changes');
    }

    function revision(ref: string) {
        return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
    }

    async function openDiff(original: vscode.Uri, modified: vscode.Uri, changedPixels: number) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.getComparisonDiagnostics().length === 0,
            () => 'Previous viewers were not disposed.');
        await vscode.commands.executeCommand('vscode.diff', original, modified, 'CHR integration comparison',
            { preview: false, override: 'nes-chr-diff-viewer.chrDiff' });
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 2 && views.every(view =>
                view.ready && !view.loading && view.partner !== undefined && view.changedPixels === changedPixels);
        }, () => `Native diff failed to pair/render:\n${JSON.stringify(api.getComparisonDiagnostics(), null, 2)}`);
        const views = api.getComparisonDiagnostics();
        assert.strictEqual(views[0].partner, views[1].id);
        assert.strictEqual(views[1].partner, views[0].id);
        assert.strictEqual(views[0].column, views[1].column);
        assert.ok(views.every(view => view.visible && view.status.includes('inferred')));
    }

    suiteSetup(async () => {
        const config = vscode.workspace.getConfiguration('git');
        previousParentSetting = config.inspect<string>('openRepositoryInParentFolders')?.globalValue;
        // Older Git extensions otherwise refuse the temporary repository outside
        // the workspace. This changes only the test host's isolated user profile.
        await config.update('openRepositoryInParentFolders', 'always', vscode.ConfigurationTarget.Global);
        const extension = vscode.extensions.all.find(candidate =>
            candidate.packageJSON.name === 'nes-chr-diff-viewer');
        assert.ok(extension, 'Development extension is available.');
        api = await extension.activate();
    });

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chr-native-diff-'));
        uri = vscode.Uri.file(path.join(directory, 'fixture.chr'));
        await git('init');
        await fs.writeFile(uri.fsPath, new Uint8Array(8192));
        await git('add', 'fixture.chr');
        await git('-c', 'user.name=CHR Tests', '-c', 'user.email=chr-tests@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-m', 'CHR test baseline');
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        assert.ok(gitExtension);
        repository = await (await gitExtension.activate()).getAPI(1).openRepository(vscode.Uri.file(directory));
        assert.ok(repository, 'Built-in Git extension opened the fixture repository.');
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (directory) {
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    suiteTeardown(async () => {
        await vscode.workspace.getConfiguration('git').update(
            'openRepositoryInParentFolders', previousParentSetting, vscode.ConfigurationTarget.Global);
    });

    test('unstaged native diff pairs exact HEAD/working buffers and refreshes both masks', async () => {
        const data = new Uint8Array(8192);
        data[0] = 128;
        await fs.writeFile(uri.fsPath, data);
        await openDiff(revision('HEAD'), uri, 1);
        data[8] = 1;
        await fs.writeFile(uri.fsPath, data);
        await waitFor(() => api.getComparisonDiagnostics().every(view => !view.loading && view.changedPixels === 2),
            () => `File watcher did not refresh both masks: ${JSON.stringify(api.getComparisonDiagnostics())}`);
    });

    test('staged native diff compares HEAD to index, not the working tree', async () => {
        await stageTwoPixels();
        await openDiff(revision('HEAD'), revision(''), 2);
    });

    test('index/working-tree comparison uses its own baseline', async () => {
        await stageTwoPixels();
        await openDiff(revision(''), uri, 7);
    });

    test('Git index updates refresh an already-open staged diff', async () => {
        await stageTwoPixels();
        await openDiff(revision('HEAD'), revision(''), 2);
        await git('add', 'fixture.chr');
        await repository?.status();
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 2 && views.every(view => !view.loading && view.changedPixels === 8);
        }, () => `Git state did not refresh index data: ${JSON.stringify(api.getComparisonDiagnostics())}`);
        const staged = new Uint8Array(8192);
        staged[0] = 128;
        staged[8] = 1;
        await fs.writeFile(uri.fsPath, staged);
        await git('add', 'fixture.chr');
        await repository?.status();
        await waitFor(() => api.getComparisonDiagnostics().every(view => !view.loading && view.changedPixels === 2),
            () => 'Git state did not restore staged data.');
    });

    test('historical native diff compares the supplied revisions', async () => {
        const baseline = await git('rev-parse', 'HEAD');
        await commitStagedPixels();
        const modified = await git('rev-parse', 'HEAD');
        await openDiff(revision(baseline), revision(modified), 2);
    });

    test('standalone preview has no comparison or stale highlighting', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.openWith', uri, 'nes-chr-diff-viewer.chrDiff');
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 1 && views[0].ready && !views[0].loading;
        }, () => `Preview did not load: ${JSON.stringify(api.getComparisonDiagnostics())}`);
        const view = api.getComparisonDiagnostics()[0];
        assert.strictEqual(view.partner, undefined);
        assert.strictEqual(view.changedPixels, 0);
        assert.match(view.status, /Preview/);
    });

    test('two comparisons of the same file in different groups stay isolated', async () => {
        await commitStagedPixels();
        await openDiff(revision('HEAD~1'), revision('HEAD'), 2);
        const data = new Uint8Array(8192);
        data[0] = 255;
        await fs.writeFile(uri.fsPath, data);
        await vscode.commands.executeCommand('vscode.diff', revision('HEAD'), uri, 'Second comparison',
            { preview: false, viewColumn: vscode.ViewColumn.Beside, override: 'nes-chr-diff-viewer.chrDiff' });
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 4 && views.every(view => view.ready && !view.loading && view.partner !== undefined);
        }, () => `Concurrent diffs failed: ${JSON.stringify(api.getComparisonDiagnostics())}`);
        const views = api.getComparisonDiagnostics();
        for (const view of views) {
            const partner = views.find(candidate => candidate.id === view.partner);
            assert.ok(partner);
            assert.strictEqual(partner.column, view.column);
            assert.strictEqual(partner.partner, view.id);
        }
        assert.deepStrictEqual(views.map(view => view.changedPixels).sort((a, b) => a - b), [2, 2, 7, 7]);
    });

    test('deleted working file clears both comparisons, then recovers on recreation', async () => {
        await commitStagedPixels();
        await openDiff(revision('HEAD'), uri, 7);
        await fs.unlink(uri.fsPath);
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 2 && views.every(view => view.partner === undefined &&
                view.changedPixels === 0 && view.status.includes('Cannot read'));
        }, () => `Deleted file left stale highlighting: ${JSON.stringify(api.getComparisonDiagnostics())}`);
        const data = new Uint8Array(8192);
        data[0] = 255;
        await fs.writeFile(uri.fsPath, data);
        await waitFor(() => api.getComparisonDiagnostics().every(view => view.partner !== undefined && view.changedPixels === 7),
            () => `Recreated file did not recover: ${JSON.stringify(api.getComparisonDiagnostics())}`);
    });

    test('hiding a diff clears inferred masks instead of pairing its hidden viewers', async () => {
        await stageTwoPixels();
        await openDiff(revision('HEAD'), uri, 8);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'nes-chr-diff-viewer.chrDiff',
            { preview: false });
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.filter(view => view.visible).length === 1 &&
                views.every(view => view.partner === undefined && view.changedPixels === 0);
        }, () => `Hidden diff retained its mask: ${JSON.stringify(api.getComparisonDiagnostics())}`);
    });

    test('unsupported file size visibly disables native diff highlighting', async () => {
        await fs.writeFile(uri.fsPath, new Uint8Array(8193));
        await vscode.commands.executeCommand('vscode.diff', revision('HEAD'), uri, 'Unsupported size comparison',
            { preview: false, override: 'nes-chr-diff-viewer.chrDiff' });
        await waitFor(() => {
            const views = api.getComparisonDiagnostics();
            return views.length === 2 && views.every(view =>
                view.ready && !view.loading && view.status.includes('Comparison unavailable'));
        }, () => `Unsupported file incorrectly compared: ${JSON.stringify(api.getComparisonDiagnostics())}`);
        assert.ok(api.getComparisonDiagnostics().every(view => view.partner === undefined && view.changedPixels === 0));
    });

    test('Show changes and 8x16 mode are remembered preferences shared by viewers', async () => {
        await stageTwoPixels();
        const stored = new Map<string, unknown>();
        const memento: vscode.Memento = {
            keys: () => [...stored.keys()],
            get: <T>(key: string, fallback?: T) => (stored.has(key) ? stored.get(key) : fallback) as T,
            update: (key: string, value: unknown) => { stored.set(key, value); return Promise.resolve(); }
        };
        let provider = new NESChrDiffProvider(memento);
        const cancellation = new vscode.CancellationTokenSource();
        const panels: vscode.WebviewPanel[] = [];
        const emitters: vscode.EventEmitter<unknown>[] = [];
        type ViewerMessage = { type?: string; showChanges?: boolean; available?: boolean; enabled?: boolean; request?: number };
        const messages: ViewerMessage[][] = [];
        const latestSpriteModes = () => messages.map(list => list.filter(message => message.type === 'spriteMode').at(-1));
        // Intercept only the message transport and visibility/group metadata.
        // Production broker and real Git reads still run unchanged.
        const openViewer = async (index: number, column: number) => {
            const panel = vscode.window.createWebviewPanel('chr-toggle-test', 'Toggle broker test',
                vscode.ViewColumn.One, {});
            panels.push(panel);
            const emitter = new vscode.EventEmitter<unknown>();
            emitters.push(emitter);
            const received: ViewerMessage[] = [];
            messages.push(received);
            const webview = new Proxy(panel.webview, {
                get(target, property) {
                    if (property === 'onDidReceiveMessage') {
                        return emitter.event;
                    }
                    if (property === 'postMessage') {
                        return (message: ViewerMessage) => {
                            received.push(message);
                            return Promise.resolve(true);
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
                set(target, property, value) {
                    return Reflect.set(target, property, value, target);
                }
            });
            const wrapper = new Proxy(panel, {
                get(target, property) {
                    if (property === 'webview') {
                        return webview;
                    }
                    if (property === 'visible') {
                        return true;
                    }
                    if (property === 'viewColumn') {
                        return column;
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            const resource = index % 2 === 0 ? revision('HEAD') : uri;
            const document = await provider.openCustomDocument(resource,
                { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
            await provider.resolveCustomEditor(document, wrapper, cancellation.token);
            emitter.fire({ type: 'ready' });
        };
        const settled = () => waitFor(
            () => provider.getComparisonDiagnostics().every(view => !view.loading && view.partner !== undefined),
            () => JSON.stringify(provider.getComparisonDiagnostics()));
        try {
            for (let index = 0; index < 4; index++) {
                await openViewer(index, index < 2 ? 1 : 2);
            }
            await settled();
            assert.ok(latestSpriteModes().every(message => message?.enabled === false), '8x8 is the default.');
            emitters[0].fire({ type: 'spriteMode', enabled: true, request: 1 });
            assert.ok(latestSpriteModes().every(message => message?.enabled === true), 'Both sides of every diff switch together.');
            assert.strictEqual(latestSpriteModes()[0]?.request, 1);
            assert.strictEqual(stored.get('nes-chr-diff-viewer.spriteMode'), true);
            assert.ok(provider.getComparisonDiagnostics().every(view => !view.showChanges), 'Off by default.');
            emitters[0].fire({ type: 'showChanges', enabled: true });
            assert.deepStrictEqual(provider.getComparisonDiagnostics().map(view => view.showChanges),
                [true, true, true, true], 'Every open diff follows the shared preference.');
            assert.ok(messages.every(list => list.at(-1)?.showChanges === true));
            assert.strictEqual(stored.get('nes-chr-diff-viewer.showChanges'), true, 'The preference is saved.');

            // The same re-read path used by file watcher and Git state events.
            const refreshVisible = () => void (provider as unknown as { refreshVisible(): Promise<void> }).refreshVisible();
            refreshVisible();
            await settled();
            assert.ok(provider.getComparisonDiagnostics().every(view => view.showChanges), 'Survives refresh.');

            const marks = messages.map(list => list.length);
            refreshVisible();
            assert.ok(provider.getComparisonDiagnostics().some(view => view.loading), 'Refresh is in flight.');
            emitters[1].fire({ type: 'showChanges', enabled: false, request: 1 });
            await waitFor(() => provider.getComparisonDiagnostics().every(view => !view.loading),
                () => 'Second refresh did not finish.');
            assert.ok(provider.getComparisonDiagnostics().every(view => !view.showChanges),
                'A click during a refresh is not lost.');
            assert.strictEqual(stored.get('nes-chr-diff-viewer.showChanges'), false);
            for (const index of [0, 1]) {
                const sent = messages[index].slice(marks[index]) as { available?: boolean; data?: unknown; mask?: unknown; toggleRequest?: number }[];
                assert.ok(sent.length > 0);
                assert.ok(sent.every(message => message.available === true),
                    `Viewer ${index} never flashes an unavailable comparison during refresh.`);
                assert.ok(sent.some(message => Array.isArray(message.data) && Array.isArray(message.mask)),
                    'Fresh data is sent together with its mask.');
            }
            assert.strictEqual((messages[1].at(-1) as { toggleRequest?: number }).toggleRequest, 1,
                'The clicking viewer receives an acknowledgement of its request.');
            refreshVisible();
            assert.ok(provider.getComparisonDiagnostics().some(view => view.loading));
            emitters[1].fire({ type: 'spriteMode', enabled: false, request: 1 });
            assert.ok(latestSpriteModes().every(message => message?.enabled === false),
                'Layout sync is immediate even while files are being re-read.');
            assert.strictEqual(latestSpriteModes()[1]?.request, 1);
            await settled();
            assert.ok(latestSpriteModes().every(message => message?.enabled === false));
            emitters[1].fire({ type: 'spriteMode', enabled: 'invalid' });
            assert.strictEqual(stored.get('nes-chr-diff-viewer.spriteMode'), false);
            emitters[0].fire({ type: 'spriteMode', enabled: true, request: 2 });
            emitters[0].fire({ type: 'showChanges', enabled: 'invalid' });
            assert.ok(provider.getComparisonDiagnostics().every(view => !view.showChanges));

            emitters[2].fire({ type: 'showChanges', enabled: true });
            panels.splice(2).forEach(panel => panel.dispose());
            emitters.splice(2).forEach(emitter => emitter.dispose());
            messages.splice(2);
            await openViewer(2, 3);
            await openViewer(3, 3);
            await settled();
            assert.deepStrictEqual(provider.getComparisonDiagnostics().map(view => view.showChanges),
                [true, true, true, true], 'A newly opened diff starts with the remembered preference.');
            assert.ok(latestSpriteModes().every(message => message?.enabled === true), 'New viewers inherit 8x16 mode.');

            panels[1].dispose();
            emitters[0].fire({ type: 'showChanges', enabled: false });
            assert.strictEqual(stored.get('nes-chr-diff-viewer.showChanges'), true,
                'An unpaired viewer cannot change the preference.');
            assert.strictEqual(provider.getComparisonDiagnostics()[0].showChanges, false,
                'An unpaired viewer never highlights.');
            assert.strictEqual(messages[0].at(-1)?.available, false);

            panels.forEach(panel => panel.dispose());
            provider.dispose();
            provider = new NESChrDiffProvider(memento);
            panels.length = 0;
            emitters.forEach(emitter => emitter.dispose());
            emitters.length = 0;
            messages.length = 0;
            await openViewer(0, 1);
            await openViewer(1, 1);
            await settled();
            assert.ok(provider.getComparisonDiagnostics().every(view => view.showChanges),
                'The preference survives an extension restart.');
            assert.ok(latestSpriteModes().every(message => message?.enabled === true), '8x16 mode survives an extension restart.');
        } finally {
            panels.forEach(panel => panel.dispose());
            emitters.forEach(emitter => emitter.dispose());
            provider.dispose();
            cancellation.dispose();
        }
    });
});

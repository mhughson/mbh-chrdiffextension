
import * as vscode from 'vscode';
import * as path from 'path';
import { CHANGED_PALETTE, GREY_PALETTE, compareChr, findComparisonPartner, ViewerIdentity } from './chrComparison';

class NESChrDocument implements vscode.CustomDocument {
    uri: vscode.Uri;
    data: Uint8Array;
    constructor(uri: vscode.Uri, data: Uint8Array) {
        this.uri = uri;
        this.data = data;
    }
    dispose(): void {
        // No resources to clean up
    }
}

const SHOW_CHANGES_KEY = 'nes-chr-diff-viewer.showChanges';

interface Viewer {
    id: number;
    document: NESChrDocument;
    panel: vscode.WebviewPanel;
    ready: boolean;
    loading: boolean;
    generation: number;
    error?: string;
    partner?: number;
    status: string;
    changedPixels: number;
    showChanges: boolean;
    dataPending: boolean;
    displayed: boolean;
    lastVisible: boolean;
    lastColumn: number | undefined;
    toggleRequest: number;
    subscriptions: vscode.Disposable[];
}

interface GitExtension {
    getAPI(version: 1): {
        getRepository(uri: vscode.Uri): { state: { onDidChange: vscode.Event<void> } } | null;
    };
}

export class NESChrDiffProvider implements vscode.CustomReadonlyEditorProvider<NESChrDocument>, vscode.Disposable {
    private readonly viewers = new Map<number, Viewer>();
    private nextId = 1;
    // One preference shared by every diff, so it carries over as the user moves between files.
    private showChanges: boolean;
    private outputChannel?: vscode.OutputChannel;

    constructor(private readonly preferences?: vscode.Memento) {
        this.showChanges = preferences?.get<boolean>(SHOW_CHANGES_KEY) === true;
    }

    private get output(): vscode.OutputChannel {
        return this.outputChannel ?? (this.outputChannel = vscode.window.createOutputChannel('NES CHR Diff Viewer'));
    }

    dispose(): void {
        for (const view of this.viewers.values()) {
            view.subscriptions.forEach(subscription => subscription.dispose());
        }
        this.viewers.clear();
        this.outputChannel?.dispose();
    }

    getComparisonDiagnostics() {
        return [...this.viewers.values()].map(view => ({
            ...this.identity(view), ready: view.ready, loading: view.loading,
            partner: view.partner, status: view.status, changedPixels: view.changedPixels,
            error: view.error, showChanges: view.showChanges
        }));
    }

    showComparisonDiagnostics(): void {
        this.output.appendLine(JSON.stringify(this.getComparisonDiagnostics(), null, 2));
        this.output.show(true);
    }

    private identity(view: Viewer): ViewerIdentity {
        const uri = view.document.uri;
        return {
            id: view.id, uri: uri.toString(), scheme: uri.scheme, filePath: uri.fsPath,
            query: uri.query, visible: view.panel.visible, column: view.panel.viewColumn
        };
    }

    private updateComparisons(): void {
        const identities = [...this.viewers.values()].map(view => this.identity(view));
        for (const view of this.viewers.values()) {
            const pairing = findComparisonPartner(this.identity(view), identities);
            const partner = pairing.partner === undefined ? undefined : this.viewers.get(pairing.partner);
            const waiting = view.loading || (partner !== undefined && (partner.loading || !partner.ready));
            if (view.ready && waiting && !view.error && !partner?.error) {
                // Keep the last consistent image and mask on screen until both sides have
                // fresh data, so refreshes never flash an empty comparison.
                if (!view.displayed && !view.loading) {
                    this.post(view, [], 'Comparison pending: waiting for both files.', false);
                }
                continue;
            }
            let mask: number[] = [];
            view.partner = undefined;
            view.changedPixels = 0;
            view.status = pairing.reason;
            if (view.error || partner?.error) {
                view.status = `Comparison unavailable: ${view.error || partner?.error}`;
            } else if (partner) {
                if (!view.ready) {
                    view.status = 'Comparison pending: waiting for both files.';
                } else {
                    try {
                        const comparison = compareChr(view.document.data, partner.document.data);
                        mask = comparison.mask;
                        view.partner = partner.id;
                        view.changedPixels = comparison.changedPixels;
                        view.status = `${pairing.reason}: ${comparison.changedPixels} changed pixels.`;
                    } catch (error) {
                        view.status = `Comparison unavailable: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
            view.showChanges = view.partner !== undefined && this.showChanges;
            if (view.ready) {
                this.post(view, mask, view.status, view.partner !== undefined);
            }
        }
    }

    // Image data and its mask travel in one message so the webview never paints
    // new pixels with a stale mask (or vice versa).
    private post(view: Viewer, mask: number[], status: string, available: boolean): void {
        const data = view.dataPending ? Array.from(view.document.data) : undefined;
        view.dataPending = false;
        view.displayed = true;
        void view.panel.webview.postMessage({
            type: 'comparison', data, mask, status, available, showChanges: this.showChanges,
            toggleRequest: view.toggleRequest
        });
    }

    private async refresh(view: Viewer): Promise<void> {
        const generation = ++view.generation;
        view.loading = true;
        try {
            const data = await vscode.workspace.fs.readFile(view.document.uri);
            if (!this.viewers.has(view.id) || generation !== view.generation) {
                return;
            }
            view.document.data = data;
            view.error = undefined;
            view.dataPending = true;
        } catch (error) {
            if (!this.viewers.has(view.id) || generation !== view.generation) {
                return;
            }
            view.error = `Cannot read ${view.document.uri.toString()}: ${error instanceof Error ? error.message : String(error)}`;
            this.output.appendLine(view.error);
            void view.panel.webview.postMessage({ type: 'error', message: view.error });
        } finally {
            if (this.viewers.has(view.id) && generation === view.generation) {
                view.loading = false;
                this.updateComparisons();
            }
        }
    }

    private async refreshVisible(): Promise<void> {
        await Promise.all([...this.viewers.values()].filter(view => view.ready && view.panel.visible)
            .map(view => this.refresh(view)));
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<NESChrDocument> {
        const fileData = await vscode.workspace.fs.readFile(uri);
        return new NESChrDocument(uri, fileData);
    }

    async resolveCustomEditor(
        document: NESChrDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };
        const view: Viewer = {
            id: this.nextId++, document, panel: webviewPanel, ready: false,
            loading: false, generation: 0, status: 'Preview: waiting for viewer.',
            changedPixels: 0, showChanges: false, dataPending: false,
            displayed: false, lastVisible: webviewPanel.visible, lastColumn: webviewPanel.viewColumn,
                        toggleRequest: 0, subscriptions: []
        };
        this.viewers.set(view.id, view);
        view.subscriptions.push(
            webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
                if (!msg || typeof msg !== 'object' || !('type' in msg)) {
                    return;
                }
                if (msg.type === 'ready') {
                    // A (re)created webview has no image yet, even if the file is unchanged.
                    view.ready = true;
                    view.displayed = false;
                    await this.refreshVisible();
                } else if (msg.type === 'showChanges' && 'enabled' in msg && typeof msg.enabled === 'boolean') {
                    // Check the live pairing rather than view.partner, which may be
                    // briefly unset while either side is re-reading its file.
                    const identities = [...this.viewers.values()].map(other => this.identity(other));
                    if ('request' in msg && typeof msg.request === 'number' && msg.request > view.toggleRequest) {
                        view.toggleRequest = msg.request;
                    }
                    if (findComparisonPartner(this.identity(view), identities).partner !== undefined) {
                        this.showChanges = msg.enabled;
                        void this.preferences?.update(SHOW_CHANGES_KEY, msg.enabled);
                    }
                    // Always answer so the webview drops its pending state, even when
                    // the toggle was rejected.
                    this.updateComparisons();
                }
            }),
            webviewPanel.onDidChangeViewState(() => {
                // Focus changes (e.g. clicking the toggle) also fire this event; only
                // visibility or editor-group changes can affect pairing or content.
                if (webviewPanel.visible === view.lastVisible && webviewPanel.viewColumn === view.lastColumn) {
                    return;
                }
                view.lastVisible = webviewPanel.visible;
                view.lastColumn = webviewPanel.viewColumn;
                this.updateComparisons();
                if (webviewPanel.visible) {
                    void this.refreshVisible();
                }
            }),
            webviewPanel.onDidDispose(() => {
                this.viewers.delete(view.id);
                view.subscriptions.forEach(subscription => subscription.dispose());
                this.updateComparisons();
            })
        );
        if (document.uri.scheme === 'file') {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath))
            );
            view.subscriptions.push(watcher,
                watcher.onDidChange(() => { void this.refreshVisible(); }),
                watcher.onDidCreate(() => { void this.refreshVisible(); }),
                watcher.onDidDelete(() => { void this.refreshVisible(); })
            );
        }
        if (document.uri.scheme === 'git') {
            const git = vscode.extensions.getExtension<GitExtension>('vscode.git');
            if (git?.isActive) {
                const repository = git.exports.getAPI(1).getRepository(vscode.Uri.file(document.uri.fsPath));
                if (repository) {
                    view.subscriptions.push(repository.state.onDidChange(() => { void this.refreshVisible(); }));
                } else {
                    this.output.appendLine(`Git state monitoring unavailable for ${document.uri.toString()}; reopen the diff to refresh.`);
                }
            } else {
                this.output.appendLine('Git state monitoring unavailable; reopen the diff to refresh.');
            }
        }
        view.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() === document.uri.toString()) {
                void this.refreshVisible();
            }
        }));
        webviewPanel.webview.html = this.getHtml();
        this.updateComparisons();
    }

    private getHtml(): string {
        // 16 tiles wide, 32 tiles high
        const initialScale = 4;
        const canvasWidth = 128 * initialScale;
        const canvasHeight = 256 * initialScale;
        function getNonce() {
            let text = '';
            const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 16; i++) {
                text += possible.charAt(Math.floor(Math.random() * possible.length));
            }
            return text;
        }
        const nonce = getNonce();
        return `
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <style>
                    .toolbar { display: flex; gap: 4px; margin-bottom: 8px; }
                    .icon-button {
                        display: inline-flex; align-items: center; justify-content: center;
                        width: 26px; height: 26px; padding: 0; box-sizing: border-box;
                        border: 1px solid transparent; border-radius: 4px; background: transparent;
                        color: var(--vscode-icon-foreground, currentColor); cursor: pointer;
                    }
                    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
                    .icon-button:focus-within {
                        outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
                    }
                    .icon-button svg { width: 16px; height: 16px; fill: currentColor; }
                    .toggle { position: relative; }
                    .toggle[hidden] { display: none; }
                    .toggle input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: inherit; }
                    /* Solid green when active so the state is obvious and matches the highlight colors. */
                    .toggle:has(input:checked), .toggle:has(input:checked):hover {
                        background: ${CHANGED_PALETTE[1]};
                        border-color: ${CHANGED_PALETTE[2]};
                        color: #FFFFFF;
                        box-shadow: 0 0 6px ${CHANGED_PALETTE[2]};
                    }
                    .toggle:has(input:disabled) { opacity: 0.4; cursor: default; }
                    .visually-hidden {
                        position: absolute; width: 1px; height: 1px; overflow: hidden;
                        clip: rect(0 0 0 0); white-space: nowrap;
                    }
                </style>
            </head>
            <body>
                <div class="toolbar">
                    <label id="showChangesLabel" class="icon-button toggle" title="Show changes" hidden>
                        <input id="showChanges" type="checkbox" disabled aria-label="Show changes">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 0 0 11.5z"/></svg>
                    </label>
                    <span id="comparisonStatus" class="visually-hidden" role="status">Preview: waiting for viewer.</span>
                </div>
                <canvas id="chrCanvas" width="${canvasWidth}" height="${canvasHeight}" style="border:1px solid #888; cursor:zoom-in;"></canvas>
                <script nonce="${nonce}">
                    const nesPalette = ${JSON.stringify(GREY_PALETTE)};
                    const changedPalette = ${JSON.stringify(CHANGED_PALETTE)};
                    let changedMask = [];
                    let showChanges = false;
                    let toggleRequest = 0;
                    const changesToggle = document.getElementById('showChanges');
                    const status = document.getElementById('comparisonStatus');
                    const changesLabel = document.getElementById('showChangesLabel');
                    // The toolbar is icon-only; the status lives in the toggle's tooltip and
                    // in a visually hidden live region for screen readers.
                    function setStatus(text) {
                        status.textContent = text;
                        changesLabel.title = 'Show changes \\u2014 ' + text;
                    }
                    // The toggle only exists while this viewer is part of a detected diff.
                    function setAvailable(available) {
                        changesToggle.disabled = !available;
                        changesLabel.hidden = !available;
                    }

                    // Allocate a default buffer for 16x32 tiles (512 tiles * 16 bytes = 8192 bytes)
                    const CHR_SIZE = 16 * 32 * 16;
                    const chr = new Uint8Array(CHR_SIZE);
                    let hasData = false;
                    let scale = ${initialScale};
                    const minScale = 1;
                    const maxScale = 32;
                    const canvas = document.getElementById('chrCanvas');
                    const ctx = canvas.getContext('2d');

                    function loadData(arr) {
                        arr = arr || [];
                        hasData = true;
                        chr.fill(0);
                        for (let i = 0; i < Math.min(CHR_SIZE, arr.length); i++) {
                            chr[i] = arr[i];
                        }
                    }

                    function drawCHR() {
                        if (!hasData) {
                            // nothing to draw yet
                            return;
                        }
                        canvas.width = 128 * scale;
                        canvas.height = 256 * scale;
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        for (let tileY = 0; tileY < 32; tileY++) {
                            for (let tileX = 0; tileX < 16; tileX++) {
                                const tileIndex = tileY * 16 + tileX;
                                const tileOffset = tileIndex * 16;
                                for (let row = 0; row < 8; row++) {
                                    const plane0 = chr[tileOffset + row] || 0;
                                    const plane1 = chr[tileOffset + row + 8] || 0;
                                    for (let col = 0; col < 8; col++) {
                                        const bit0 = (plane0 >> (7 - col)) & 1;
                                        const bit1 = (plane1 >> (7 - col)) & 1;
                                        const colorIndex = (bit1 << 1) | bit0;
                                        const pixel = (tileY * 8 + row) * 128 + tileX * 8 + col;
                                        ctx.fillStyle = (showChanges && changedMask[pixel] ? changedPalette : nesPalette)[colorIndex];
                                        ctx.fillRect(
                                            (tileX * 8 + col) * scale,
                                            (tileY * 8 + row) * scale,
                                            scale, scale
                                        );
                                    }
                                }
                            }
                        }
                    }

                    // Handle incoming messages from the extension
                    window.addEventListener('message', (event) => {
                        const msg = event.data;
                        if (!msg || !msg.type) return;
                        if (msg.type === 'init' || msg.type === 'update') {
                            loadData(msg.data);
                            drawCHR();
                        } else if (msg.type === 'comparison') {
                            if (msg.data) {
                                loadData(msg.data);
                            }
                            changedMask = msg.mask;
                            // Messages sent before the host saw our latest click must not
                            // overwrite it, or the checkbox flips back and forth.
                            if ((msg.toggleRequest || 0) >= toggleRequest) {
                                changesToggle.checked = msg.showChanges;
                            }
                            showChanges = changesToggle.checked && msg.available;
                            setAvailable(msg.available);
                            setStatus(msg.status);
                            drawCHR();
                        } else if (msg.type === 'error' || msg.type === 'deleted') {
                            // Clear buffer
                            for (let i = 0; i < CHR_SIZE; i++) chr[i] = 0;
                            hasData = false;
                            changedMask = [];
                            showChanges = false;
                            setAvailable(false);
                            setStatus(msg.message || 'File deleted.');
                            // clear canvas
                            canvas.width = 128 * scale;
                            canvas.height = 256 * scale;
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            drawCHR();
                        }
                    });

                    // Notify the extension that the webview HTML is ready to receive messages
                    const vscode = acquireVsCodeApi();
                    changesToggle.addEventListener('change', () => {
                        showChanges = changesToggle.checked;
                        drawCHR();
                        vscode.postMessage({ type: 'showChanges', enabled: changesToggle.checked, request: ++toggleRequest });
                    });
                    // Post a 'ready' message on next tick so the handler above is registered
                    setTimeout(() => vscode.postMessage({ type: 'ready' }), 0);

                    // Smooth zoom on mouse wheel
                    canvas.addEventListener('wheel', function(e) {
                        e.preventDefault();
                        // Use exponential scaling for smoothness
                        const zoomFactor = 1.1;
                        if (e.deltaY < 0) {
                            scale = Math.min(maxScale, scale * zoomFactor);
                        } else {
                            scale = Math.max(minScale, scale / zoomFactor);
                        }
                        drawCHR();
                    }, { passive: false });
                </script>
            </body>
            </html>
        `;
    }
}
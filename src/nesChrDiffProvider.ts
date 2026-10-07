
import * as vscode from 'vscode';
import * as path from 'path';
import { compareChr, findComparisonPartner, ViewerIdentity } from './chrComparison';
import { CONFIG_SECTION, Palettes, readPalettes } from './palette';

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
    private readonly configSubscription: vscode.Disposable;

    constructor(private readonly preferences?: vscode.Memento) {
        this.showChanges = preferences?.get<boolean>(SHOW_CHANGES_KEY) === true;
        this.configSubscription = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(CONFIG_SECTION)) {
                for (const view of this.viewers.values()) {
                    if (view.ready) {
                        this.postPalettes(view);
                    }
                }
            }
        });
    }

    private get palettes(): Palettes {
        return readPalettes(vscode.workspace.getConfiguration(CONFIG_SECTION));
    }

    private postPalettes(view: Viewer): void {
        void view.panel.webview.postMessage({ type: 'palette', ...this.palettes });
    }

    private get output(): vscode.OutputChannel {
        return this.outputChannel ?? (this.outputChannel = vscode.window.createOutputChannel('NES CHR Diff Viewer'));
    }

    dispose(): void {
        this.configSubscription.dispose();
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
                    // Settings may have changed between building the HTML and the script running.
                    this.postPalettes(view);
                    await this.refreshVisible();
                } else if (msg.type === 'openSettings') {
                    await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.`);
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
        const { palette, changedPalette } = this.palettes;
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
                    html, body { height: 100%; }
                    body {
                        margin: 0; padding: 8px; box-sizing: border-box; overflow: hidden;
                        display: flex; flex-direction: column;
                    }
                    .toolbar { display: flex; gap: 4px; margin-bottom: 8px; flex: none; }
                    .separator { width: 1px; margin: 4px 2px; background: var(--vscode-widget-border, rgba(128,128,128,0.35)); }
                    .spacer { flex: 1; }
                    #viewport { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
                    #chrCanvas { display: block; margin: auto; border: 1px solid #888; cursor: zoom-in; }
                    /* Grid + auto margins centers a small image but still scrolls fully when it is larger. */
                    #viewport { display: grid; }
                    .icon-button {
                        display: inline-flex; align-items: center; justify-content: center;
                        width: 26px; height: 26px; padding: 0; box-sizing: border-box;
                        border: 1px solid transparent; border-radius: 4px; background: transparent;
                        color: var(--vscode-icon-foreground, currentColor); cursor: pointer;
                    }
                    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
                    .icon-button:focus-within, button.icon-button:focus-visible {
                        outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
                    }
                    .icon-button svg { width: 16px; height: 16px; fill: currentColor; }
                    /* The current zoom mode is shown as a solid, theme-colored button. */
                    .icon-button.active, .icon-button.active:hover {
                        background: var(--vscode-button-background, #0e639c);
                        border-color: var(--vscode-focusBorder, #007fd4);
                        color: var(--vscode-button-foreground, #FFFFFF);
                    }
                    .toggle { position: relative; }
                    .toggle[hidden] { display: none; }
                    .toggle input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: inherit; }
                    /* Uses the changed-pixel colors so the active state matches the highlighting. */
                    .toggle:has(input:checked), .toggle:has(input:checked):hover {
                        background: var(--changed-background);
                        border-color: var(--changed-border);
                        color: #FFFFFF;
                        box-shadow: 0 0 6px var(--changed-border);
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
                    <button id="zoomFit" class="icon-button active" title="Zoom to fit" aria-label="Zoom to fit" aria-pressed="true">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                    <button id="zoomFill" class="icon-button" title="Zoom to fill" aria-label="Zoom to fill" aria-pressed="false">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                    <span class="separator" aria-hidden="true"></span>
                    <label id="showChangesLabel" class="icon-button toggle" title="Show changes" hidden>
                        <input id="showChanges" type="checkbox" disabled aria-label="Show changes">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 0 0 11.5z"/></svg>
                    </label>
                    <span class="spacer"></span>
                    <button id="openSettings" class="icon-button" title="Configure colors" aria-label="Configure colors">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="2.2 2.2"/><circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                    <span id="comparisonStatus" class="visually-hidden" role="status">Preview: waiting for viewer.</span>
                </div>
                <div id="viewport">
                    <canvas id="chrCanvas" width="128" height="256"></canvas>
                </div>
                <script nonce="${nonce}">
                    let nesPalette = ${JSON.stringify(palette)};
                    let changedPalette = ${JSON.stringify(changedPalette)};
                    let changedMask = [];
                    let showChanges = false;
                    let toggleRequest = 0;
                    const changesToggle = document.getElementById('showChanges');
                    const status = document.getElementById('comparisonStatus');
                    const changesLabel = document.getElementById('showChangesLabel');
                    const viewport = document.getElementById('viewport');
                    const fitButton = document.getElementById('zoomFit');
                    const fillButton = document.getElementById('zoomFill');
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
                    function applyPalettes(palette, changed) {
                        nesPalette = palette;
                        changedPalette = changed;
                        document.documentElement.style.setProperty('--changed-background', changed[1]);
                        document.documentElement.style.setProperty('--changed-border', changed[2]);
                    }
                    applyPalettes(nesPalette, changedPalette);

                    // Allocate a default buffer for 16x32 tiles (512 tiles * 16 bytes = 8192 bytes)
                    const CHR_SIZE = 16 * 32 * 16;
                    const chr = new Uint8Array(CHR_SIZE);
                    let hasData = false;
                    const minScale = 0.25;
                    const maxScale = 32;
                    // 'fit' and 'fill' track the panel size; wheel zoom switches to 'manual'.
                    let zoomMode = 'fit';
                    let scale = 1;
                    const canvas = document.getElementById('chrCanvas');
                    const ctx = canvas.getContext('2d');

                    function clampScale(value) {
                        return Math.min(maxScale, Math.max(minScale, value));
                    }
                    function modeScale(mode) {
                        // Leave room for the 1px canvas border on each side.
                        const width = Math.max(0, viewport.clientWidth - 2) / 128;
                        const height = Math.max(0, viewport.clientHeight - 2) / 256;
                        return clampScale(mode === 'fill' ? Math.max(width, height) : Math.min(width, height));
                    }
                    function setZoomMode(mode) {
                        zoomMode = mode;
                        for (const [button, buttonMode] of [[fitButton, 'fit'], [fillButton, 'fill']]) {
                            button.classList.toggle('active', mode === buttonMode);
                            button.setAttribute('aria-pressed', String(mode === buttonMode));
                        }
                        if (mode !== 'manual') {
                            scale = modeScale(mode);
                        }
                        drawCHR();
                    }

                    function loadData(arr) {
                        arr = arr || [];
                        hasData = true;
                        chr.fill(0);
                        for (let i = 0; i < Math.min(CHR_SIZE, arr.length); i++) {
                            chr[i] = arr[i];
                        }
                    }

                    function drawCHR() {
                        canvas.width = Math.floor(128 * scale);
                        canvas.height = Math.floor(256 * scale);
                        if (!hasData) {
                            // nothing to draw yet
                            return;
                        }
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        // Pixel edges are snapped to whole device pixels so fractional zoom
                        // levels stay crisp without seams between NES pixels.
                        const edges = [];
                        for (let i = 0; i <= 256; i++) {
                            edges.push(Math.round(i * scale));
                        }
                        for (let tileY = 0; tileY < 32; tileY++) {
                            for (let tileX = 0; tileX < 16; tileX++) {
                                const tileIndex = tileY * 16 + tileX;
                                const tileOffset = tileIndex * 16;
                                for (let row = 0; row < 8; row++) {
                                    const plane0 = chr[tileOffset + row] || 0;
                                    const plane1 = chr[tileOffset + row + 8] || 0;
                                    const y = tileY * 8 + row;
                                    for (let col = 0; col < 8; col++) {
                                        const bit0 = (plane0 >> (7 - col)) & 1;
                                        const bit1 = (plane1 >> (7 - col)) & 1;
                                        const colorIndex = (bit1 << 1) | bit0;
                                        const x = tileX * 8 + col;
                                        const pixel = y * 128 + x;
                                        ctx.fillStyle = (showChanges && changedMask[pixel] ? changedPalette : nesPalette)[colorIndex];
                                        ctx.fillRect(edges[x], edges[y], edges[x + 1] - edges[x], edges[y + 1] - edges[y]);
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
                        } else if (msg.type === 'palette') {
                            applyPalettes(msg.palette, msg.changedPalette);
                            drawCHR();
                        } else if (msg.type === 'error' || msg.type === 'deleted') {
                            chr.fill(0);
                            hasData = false;
                            changedMask = [];
                            showChanges = false;
                            setAvailable(false);
                            setStatus(msg.message || 'File deleted.');
                            drawCHR();
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                        }
                    });

                    const vscode = acquireVsCodeApi();
                    changesToggle.addEventListener('change', () => {
                        showChanges = changesToggle.checked;
                        drawCHR();
                        vscode.postMessage({ type: 'showChanges', enabled: changesToggle.checked, request: ++toggleRequest });
                    });
                    fitButton.addEventListener('click', () => setZoomMode('fit'));
                    fillButton.addEventListener('click', () => setZoomMode('fill'));
                    document.getElementById('openSettings').addEventListener('click', () => {
                        vscode.postMessage({ type: 'openSettings' });
                    });
                    window.addEventListener('resize', () => {
                        if (zoomMode !== 'manual') {
                            setZoomMode(zoomMode);
                        }
                    });
                    setZoomMode('fit');
                    // Post a 'ready' message on next tick so the handler above is registered
                    setTimeout(() => vscode.postMessage({ type: 'ready' }), 0);

                    // Mouse model: click zooms in, Alt+click zooms out, the wheel scrolls and
                    // Alt+wheel zooms. Everything zooms toward the mouse.
                    const clickZoomFactor = 2;
                    const wheelZoomFactor = 1.1;
                    let altUsed = false;

                    // Key events only reach this page while it has keyboard focus, so every
                    // mouse event also refreshes the Alt state the cursor depends on.
                    function setAlt(down) {
                        canvas.style.cursor = down ? 'zoom-out' : 'zoom-in';
                    }
                    // Keeps the image point under the mouse in place while the scale changes.
                    function zoomAt(newScale, clientX, clientY) {
                        const before = canvas.getBoundingClientRect();
                        const imageX = (clientX - before.left - 1) / scale;
                        const imageY = (clientY - before.top - 1) / scale;
                        scale = clampScale(newScale);
                        setZoomMode('manual');
                        const after = canvas.getBoundingClientRect();
                        viewport.scrollLeft += after.left + 1 + imageX * scale - clientX;
                        viewport.scrollTop += after.top + 1 + imageY * scale - clientY;
                    }

                    canvas.addEventListener('pointerdown', (e) => {
                        setAlt(e.altKey);
                        if (e.button !== 0) return;
                        e.preventDefault();
                        altUsed = altUsed || e.altKey;
                        zoomAt(e.altKey ? scale / clickZoomFactor : scale * clickZoomFactor, e.clientX, e.clientY);
                    });
                    viewport.addEventListener('pointerover', (e) => setAlt(e.altKey));
                    viewport.addEventListener('pointermove', (e) => setAlt(e.altKey));
                    viewport.addEventListener('wheel', (e) => {
                        setAlt(e.altKey);
                        // A plain wheel scrolls the viewport normally.
                        if (!e.altKey) return;
                        e.preventDefault();
                        altUsed = true;
                        // Some systems report Alt+wheel as horizontal scrolling.
                        const delta = e.deltaY || e.deltaX;
                        if (delta) {
                            zoomAt(delta < 0 ? scale * wheelZoomFactor : scale / wheelZoomFactor, e.clientX, e.clientY);
                        }
                    }, { passive: false });

                    // Capture phase, so these run before VS Code forwards keys to the workbench.
                    window.addEventListener('keydown', (e) => {
                        if (e.key === 'Alt') {
                            if (!e.repeat) {
                                altUsed = false;
                            }
                            setAlt(true);
                        }
                    }, true);
                    window.addEventListener('keyup', (e) => {
                        if (e.key === 'Alt') {
                            setAlt(false);
                            if (altUsed) {
                                // VS Code cannot see the click or wheel, so a forwarded Alt release
                                // would look like a lone Alt press and focus the menu bar.
                                altUsed = false;
                                e.stopPropagation();
                            }
                        }
                    }, true);
                    window.addEventListener('blur', () => setAlt(false));
                    setAlt(false);
                </script>
            </body>
            </html>
        `;
    }
}


import * as vscode from 'vscode';

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

export class NESChrDiffProvider implements vscode.CustomEditorProvider<NESChrDocument> {
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
        // Render the diff view (placeholder for now)
        webviewPanel.webview.html = this.getHtml(document.data);
    }

    // Required stub methods for CustomEditorProvider
    onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<NESChrDocument>>().event;

    async saveCustomDocument(document: NESChrDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // No-op for read-only diff
    }
    async saveCustomDocumentAs(document: NESChrDocument, targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        // No-op for read-only diff
    }
    async revertCustomDocument(document: NESChrDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // No-op for read-only diff
    }
    async backupCustomDocument(document: NESChrDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        // No-op for read-only diff
        return {
            id: document.uri.toString(),
            delete: () => {}
        };
    }

    private getHtml(chrData: Uint8Array): string {
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
            </head>
            <body>
                <canvas id="chrCanvas" width="${canvasWidth}" height="${canvasHeight}" style="border:1px solid #888; cursor:zoom-in;"></canvas>
                <script nonce="${nonce}">
                    // Grayscale palette: black to white
                    const nesPalette = [
                        '#000000', // black
                        '#555555', // dark gray
                        '#AAAAAA', // light gray
                        '#FFFFFF'  // white
                    ];
                    const chr = new Uint8Array([${Array.from(chrData).join(',')}]);
                    let scale = ${initialScale};
                    const minScale = 1;
                    const maxScale = 32;
                    const canvas = document.getElementById('chrCanvas');
                    const ctx = canvas.getContext('2d');

                    function drawCHR() {
                        canvas.width = 128 * scale;
                        canvas.height = 256 * scale;
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        for (let tileY = 0; tileY < 32; tileY++) {
                            for (let tileX = 0; tileX < 16; tileX++) {
                                const tileIndex = tileY * 16 + tileX;
                                const tileOffset = tileIndex * 16;
                                for (let row = 0; row < 8; row++) {
                                    const plane0 = chr[tileOffset + row];
                                    const plane1 = chr[tileOffset + row + 8];
                                    for (let col = 0; col < 8; col++) {
                                        const bit0 = (plane0 >> (7 - col)) & 1;
                                        const bit1 = (plane1 >> (7 - col)) & 1;
                                        const colorIndex = (bit1 << 1) | bit0;
                                        ctx.fillStyle = nesPalette[colorIndex % nesPalette.length];
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
                    drawCHR();

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
                        // If there is a second canvas (diff view), scale it too
                        const canvasB = document.getElementById('chrCanvasB');
                        if (canvasB) {
                            const ctxB = canvasB.getContext('2d');
                            canvasB.width = 128 * scale;
                            canvasB.height = 256 * scale;
                            ctxB.clearRect(0, 0, canvasB.width, canvasB.height);
                            // For demo, use same data
                            for (let tileY = 0; tileY < 32; tileY++) {
                                for (let tileX = 0; tileX < 16; tileX++) {
                                    const tileIndex = tileY * 16 + tileX;
                                    const tileOffset = tileIndex * 16;
                                    for (let row = 0; row < 8; row++) {
                                        const plane0 = chr[tileOffset + row];
                                        const plane1 = chr[tileOffset + row + 8];
                                        for (let col = 0; col < 8; col++) {
                                            const bit0 = (plane0 >> (7 - col)) & 1;
                                            const bit1 = (plane1 >> (7 - col)) & 1;
                                            const colorIndex = (bit1 << 1) | bit0;
                                            ctxB.fillStyle = nesPalette[colorIndex % nesPalette.length];
                                            ctxB.fillRect(
                                                (tileX * 8 + col) * scale,
                                                (tileY * 8 + row) * scale,
                                                scale, scale
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }, { passive: false });
                </script>
            </body>
            </html>
        `;
    }
}
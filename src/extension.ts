// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { NESChrDiffProvider } from './nesChrDiffProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "nes-chr-diff-viewer" is now active!');

	// Register the custom diff provider for .chr files
	const provider = new NESChrDiffProvider(context.globalState);
	context.subscriptions.push(provider);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			'nes-chr-diff-viewer.chrDiff',
			provider,
			{
				supportsMultipleEditorsPerDocument: true
			}
		)
	);

	// Hello World command remains
	const disposable = vscode.commands.registerCommand('nes-chr-diff-viewer.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from NES CHR Diff Viewer!');
	});
	context.subscriptions.push(disposable);
	context.subscriptions.push(vscode.commands.registerCommand(
		'nes-chr-diff-viewer.comparisonDiagnostics', () => provider.showComparisonDiagnostics()
	));
	return { getComparisonDiagnostics: () => provider.getComparisonDiagnostics() };
}

// This method is called when your extension is deactivated
export function deactivate() {}

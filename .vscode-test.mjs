import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
});

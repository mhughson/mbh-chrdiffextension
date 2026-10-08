# NES CHR Diff Viewer for Visual Studio Code

NES CHR Diff Viewer is a Visual Studio Code extension that provides a visual preview and diffing experience for NES CHR ROM files (`*.chr`). It renders CHR data as a 4-color image and supports side-by-side "before/after" views when inspecting changes in source control.

## Features

- Visual preview for `*.chr` files rendered as NES tiles using a grayscale palette.
- 8x16 sprite view toggle: stacks consecutive even/odd tiles as top/bottom halves, with 16 sprites per row and separate 4 KB pattern tables. The mode is synchronized across viewers and remembered between sessions.
- Side-by-side diff view for CHR files in Source Control (shows before and after states).
- Diff Highlight: shows areas of CHR file that have changed.
- Live update: the viewer refreshes when the underlying file changes on disk.

## Installation

Install from the Visual Studio Code Marketplace (COMING SOON) or use the provided VSIX in this repository:

1. Download the latest installer from: https://github.com/mhughson/mbh-chrdiffextension/releases
2. Open the Extensions view in VS Code.
3. Install the shipped VSIX: `Extensions: Install from VSIX...` and select `nes-chr-diff-viewer-X.X.X.vsix`.

## Usage

- Open a `*.chr` file in the Explorer to see a visual preview of the CHR tile set.
- Open a CHR file from the Source Control diff view to see a side-by-side comparison of the file's previous and current contents.
- The viewer automatically reloads when the file is modified on disk.

## Screenshots

### Viewer:

<img width="957" height="801" alt="image" src="https://github.com/user-attachments/assets/6019235d-3781-4edc-85d8-0c34ef586219" />

### Diff View (w/difference highlight active):

<img width="957" height="801" alt="image" src="https://github.com/user-attachments/assets/59ab5d01-d380-4794-b7c6-dc31438d2629" />

### Diff View (standard):

<img width="957" height="801" alt="image" src="https://github.com/user-attachments/assets/04bac117-7cf8-4b1a-aa87-0de692db3886" />

## Development

This extension is an early-stage project. To build and run locally:

```powershell
npm install
npm run compile
```

To run the extension in the Extension Development Host, press F5 in VS Code. This will open a new instance of VSCode with the extension enabled. You can then open a folder for a project to test out the functionality.

## Contributing

Contributions are welcome. Please open issues or PRs on the project's GitHub repository. Consider the following when contributing:

- Keep changes small and focused.
- Add tests for new functionality when practical.

## License

[View LICENSE](./LICENSE)

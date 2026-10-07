# NES CHR Diff Viewer for Visual Studio Code

NES CHR Diff Viewer is a Visual Studio Code extension that provides a visual preview and diffing experience for NES CHR ROM files (`*.chr`). It renders CHR data as a 4-color image and supports side-by-side "before/after" views when inspecting changes in source control.

## Features

- Visual preview for `*.chr` files rendered as NES tiles using a grayscale palette.
- Side-by-side diff view for CHR files in Source Control (shows before and after states).
- Optional green shades highlight changed pixels on both sides.
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

### Native Git diff highlighting

Open a CHR change using VS Code's existing side-by-side diff editor. If needed,
use **Reopen Editor With... > NES CHR Diff Viewer**. The viewers share their
actual file buffers through the extension; no comparison against an assumed
`HEAD` revision is substituted.

Stable VS Code does not explicitly give custom editors their comparison partner.
This extension therefore infers a pair only when exactly two CHR viewers are
visible in the same editor group, their distinct resources refer to the same
path, and at least one is a recognized built-in `git:` resource. While a diff is
detected, each viewer shows a half-filled circle diff icon (**Show changes**).
Hover it to see the comparison status, for example
**Git comparison (inferred from visible viewers)** and the changed-pixel count.
Both images use their original grayscale
colors by default. Toggle the diff icon in either viewer to render changed
pixels in green shades while unchanged pixels stay grayscale. Changes to black
appear dark green. The toggle is a single remembered preference: it applies to
both sides of every open diff, carries over to diffs you open next, and is saved
across VS Code restarts. It preserves zoom and can be switched off to inspect
unobstructed artwork. Highlighting is off until you first turn it on.
The diff icon turns solid green on both viewers while active, and is hidden
when there is no detected comparison (for example, a single CHR file).

Supported cases include working-tree/index, HEAD/index (staged), and comparisons
between Git revisions of the same file. Separate editor groups are isolated,
even when they compare the same path. Highlighting is cleared when a partner
is hidden, closed, unavailable, or ambiguous.

This is a conservative workaround, not a native diff API guarantee. Renames,
submodules, arbitrary file/file comparisons, unknown URI formats, and inline or
multi-file diff layouts are not supported by the pairing rule. Unsupported
visible pairs do not show the diff icon and never show guessed highlights. The
comparison diagnostics command reports why (for example **Comparison unavailable**
or **Preview: no detected comparison**).

Comparison supports complete 16-byte tiles in files up to 8192 bytes, matching
the existing 16-by-32-tile viewer. Added/removed tiles count as 64 changed pixels,
including zero-filled tiles. Unsupported file sizes disable highlighting rather
than silently ignoring changes outside the displayed area.

Working-file changes and built-in Git repository state changes trigger re-reads.
If the Git extension is not tracking the repository (for example, it is outside
the workspace), close and reopen the diff to re-read the Git index.
Read errors clear the affected canvas and both masks.
For troubleshooting, run **NES CHR: Show Comparison Diagnostics**: the output
lists viewer URIs, editor groups, pairing decisions, and changed-pixel counts,
but not file contents.

## Screenshots

Viewer:

![CHR Viewer](assets/screenshots/viewer_screenshot.png)

Diff view (before / after):

![CHR Diff Viewer](assets/screenshots/diff_screenshot.png)

## Development

This extension is an early-stage project. To build and run locally:

```powershell
npm install
npm run compile
```

To run the extension in the Extension Development Host, press F5 in VS Code.

### Verification

```powershell
npm test
```

To verify the minimum supported VS Code version:

```powershell
npm test -- --code-version 1.104.0
```

On Windows, use `npm.cmd` instead of `npm` if PowerShell blocks `npm.ps1`.
The first test run downloads VS Code. Tests run in a separate VS Code instance
with other installed extensions disabled.

The suite verifies exact pixel masks for both CHR bitplanes, tile additions and
removals, conservative pairing failures, and the production webview script's
grayscale defaults, green changed-pixel rendering, toggle synchronization, zoom
preservation, and error recovery. Native
integration tests create a temporary Git repository and open real VS Code
diffs to check working-tree, staged, index, historical, concurrent-editor-group,
Git-state refresh, file deletion/recreation, hidden-viewer cleanup, unsupported
file sizes, and standalone-preview behavior.
The temporary repositories are removed after testing.

For a manual smoke test in the F5 host:

1. Open a repository with a tracked CHR file containing complete tiles.
2. Change a known pixel and click the file under **Source Control > Changes**.
3. Hover the diff icon on both sides and confirm the inferred comparison status
   and expected count; confirm unobstructed grayscale artwork. Toggle the diff icon on either side
   and confirm both sides highlight only changed pixels in green.
4. Stage the file, then modify a different pixel without staging it. Check
   **Staged Changes** and **Changes** independently: their baselines must differ.
5. Open another comparison in a different editor group. Close or hide one
   comparison and confirm no remaining standalone viewer retains highlighting.
6. Edit the working file while its diff is open; check both counts refresh.
   Reopen the diff if investigating an index refresh.

## Contributing

Contributions are welcome. Please open issues or PRs on the project's GitHub repository. Consider the following when contributing:

- Keep changes small and focused.
- Add tests for new functionality when practical.

## License

[View LICENSE](./LICENSE)

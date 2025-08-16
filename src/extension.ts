import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const DEBUG_TYPE = 'pocketpy';
const DEFAULT_PORT = 6110;
const DEFAULT_HOST = 'localhost';


export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new PythonDebugAdapterDescriptorFactory())
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new PathMappingTrackerFactory())
  );

  // Register command to load and display line profiler results
  const loadProfilerCmd = vscode.commands.registerCommand('pocketpy.loadProfilerReportJson', async () => {
    try {
      // Step 1: Let user choose the JSON profile file
      const jsonUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'JSON': ['json'] },
        openLabel: 'Select profile JSON'
      });
      if (!jsonUris || jsonUris.length === 0) { return; }
      const jsonPath = jsonUris[0].fsPath;

      // Step 2: Let user choose the source root directory (where relative paths are resolved)
      const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select source root directory'
      });
      if (!folderUris || folderUris.length === 0) { return; }
      const sourceRoot = folderUris[0].fsPath;

      // Step 3: Read and parse the JSON
      const raw = await fs.promises.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw) as any;
      const records: Record<string, Array<[number, number, number]>> = parsed.records ?? {};
      const clocksPerSec: number = typeof parsed.CLOCKS_PER_SEC === 'number' && isFinite(parsed.CLOCKS_PER_SEC)
        ? parsed.CLOCKS_PER_SEC
        : 1_000_000; // default to microsecond resolution if absent

      // Step 4: Create a decorator to render per-line metrics at line start
      if (currentLineProfiler) {
        try { currentLineProfiler.dispose(); } catch { /* ignore */ }
      }
      currentLineProfiler = new LineProfilerDecorator(context, records, sourceRoot, clocksPerSec);
      context.subscriptions.push(currentLineProfiler);
      const refresh = () => currentLineProfiler?.refreshVisibleEditors();
      context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refresh));
      context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(refresh));
      currentLineProfiler.refreshVisibleEditors();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load line profiler: ${err.message ?? err}`);
    }
  });
  context.subscriptions.push(loadProfilerCmd);
}

export function deactivate() { }

class PythonDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.DebugAdapterDescriptor | null> {
    const config = session.configuration;
    const requestType = config.request;
    const port = config.port || DEFAULT_PORT;
    const host = config.host || DEFAULT_HOST;
    const sourceFolder = config.sourceFolder;
    if (requestType === 'attach') {
      return new vscode.DebugAdapterServer(port, host);
    }
    if (requestType === 'launch') {
      const program = config.program;
      const args = config.args;
      const terminal = vscode.window.createTerminal({
        name: 'pocketpy',
        cwd: sourceFolder
      });
      terminal.sendText(`${program} ${args.join(' ')}`);
      terminal.show();
      await new Promise(resolve => setTimeout(resolve, 3000));
      return new vscode.DebugAdapterServer(port, host);
    }
    vscode.window.showErrorMessage(`unsupported type: ${requestType}`);
    return null;
  }
}

class PathMappingTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    function toRelativePath(absPath: string): string {
      if (absPath.startsWith(workspaceFolder)) {
        return path.relative(workspaceFolder, absPath);
      }
      return absPath;
    }

    function toAbsolutePath(relPath: string): string {
      if (!path.isAbsolute(relPath)) {
        return path.join(workspaceFolder, relPath);
      }
      return relPath;
    }

    return {
      onWillReceiveMessage(message) {
        if (message.command === 'setBreakpoints' && message.arguments?.source?.path) {
          message.arguments.source.path = toRelativePath(message.arguments.source.path);
        }
      },

      onDidSendMessage(message) {
        if (message.body?.source?.path) {
          message.body.source.path = toAbsolutePath(message.body.source.path);
        }

        if (Array.isArray(message.body?.stackFrames)) {
          for (const frame of message.body.stackFrames) {
            if (frame.source?.path) {
              frame.source.path = toAbsolutePath(frame.source.path);
            }
          }
        }
        if (message.type === 'event' && message.event === 'fatalError') {
          const errorMsg = message.body?.message || 'Unknown fatal error';
          vscode.window.showErrorMessage(`[C11 Debugger] ${errorMsg}`);
        }
      }
    };
  }
}

let currentLineProfiler: LineProfilerDecorator | undefined;

class LineProfilerDecorator implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly prefixDecorationType: vscode.TextEditorDecorationType;
  private editorToDecorationTypes: Map<string, vscode.TextEditorDecorationType[]> = new Map();

  constructor(
    context: vscode.ExtensionContext,
    private readonly data: Record<string, Array<[number, number, number]>>, // relPath -> [line, hits, time]
    private readonly sourceRoot: string,
    private readonly clocksPerSec: number
  ) {
    this.context = context;
    // Prefix percentage before the code; fixed styling (not theme-driven)
    this.prefixDecorationType = vscode.window.createTextEditorDecorationType({
      before: { margin: '0 18px 0 0', color: '#0b5bd7' }
    });
  }

  // No preparation needed for data URIs
  async prepare(): Promise<void> { return; }

  dispose(): void {
    this.prefixDecorationType.dispose();
    for (const dts of this.editorToDecorationTypes.values()) {
      for (const dt of dts) dt.dispose();
    }
    this.editorToDecorationTypes.clear();
  }

  refreshVisibleEditors(): void {
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.languageId !== 'python') {
        editor.setDecorations(this.prefixDecorationType, []);
        this.clearEditorDecorations(editor);
        continue;
      }
      this.applyToEditor(editor);
    }
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const relPath = path
      .relative(this.sourceRoot, editor.document.uri.fsPath)
      .replace(/\\+/g, '/');
    const records = this.data[relPath];

    if (!records || records.length === 0) {
      editor.setDecorations(this.prefixDecorationType, []);
      this.clearEditorDecorations(editor);
      return;
    }

    // Use total time instead of max time for percentage and intensity mapping
    const totalTime = records.reduce((sum, [, , time]) => sum + time, 0);

    // Group by color (continuous mapping) for full-line background tint; and build prefix labels
    const colorToOptions: Map<string, vscode.DecorationOptions[]> = new Map();
    const prefixOptions: vscode.DecorationOptions[] = [];
    const coveredLines = new Set<number>();
    for (const [line, hits, time] of records) {
      const ratio = Math.max(0, Math.min(1, time / totalTime));
      const percent = Math.round(ratio * 100);
      // Gamma correction then quantize to limit decoration types
      const intensity = Math.pow(ratio, 2.2);
      const alpha = +(intensity * 0.6).toFixed(2);
      const color = `hsla(214, 78%, 95%, ${alpha})`;
      const hover = new vscode.MarkdownString(`${percent}% — ${this.formatDuration(time)}  •  ${hits} hits`);
      hover.isTrusted = false;
      const option: vscode.DecorationOptions = {
        range: new vscode.Range(line - 1, 0, line - 1, 0),
        hoverMessage: hover
      };
      const arr = colorToOptions.get(color) ?? [];
      arr.push(option);
      colorToOptions.set(color, arr);
      const label = `${String(percent).padStart(3, ' ')}%`;
      const textColor = '#f0f0f0';
      prefixOptions.push({
        range: new vscode.Range(line - 1, 0, line - 1, 0),
        renderOptions: {
          before: {
            contentText: label,
            color: textColor,
            margin: '0 8px 0 0',
            width: '50px',
            fontStyle: 'normal',
            height: '98%',
            textDecoration: [
              'display:inline-block',
              'box-sizing:border-box',
              'text-align:right',
              'padding-right:6px',
              'border-right:10px solid #4CAF50',
            ].join(';')
          }
        }
      });


      coveredLines.add(line - 1);
    }

    // Add empty prefix padding for lines without profile data to keep layout aligned
    const padOptions: vscode.DecorationOptions[] = [];
    const totalLines = editor.document.lineCount;
    for (let i = 0; i < totalLines; i++) {
      if (coveredLines.has(i)) continue;
      padOptions.push({
        range: new vscode.Range(i, 0, i, 0),
        renderOptions: {
          before: {
            contentText: '',
            margin: '0 8px 0 0',
            width: '50px',
            // fontStyle: 'normal',
            textDecoration: [
              'display:inline-block',
              'box-sizing:border-box',
              // 'text-align:right',
              'padding-right:6px',
            ].join(';')
          }
        }
      });
    }

    // Clear all existing decorations for this editor
    editor.setDecorations(this.prefixDecorationType, []);
    this.clearEditorDecorations(editor);

    // Apply full-line tinted backgrounds per color; decoration types are ephemeral per-editor
    const createdDts: vscode.TextEditorDecorationType[] = [];
    for (const [color, options] of colorToOptions.entries()) {
      const dt = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: color });
      createdDts.push(dt);
      editor.setDecorations(dt, options);
    }
    this.editorToDecorationTypes.set(editor.document.uri.toString(), createdDts);
    // Apply prefix percentage decorations (plus padding for non-profiled lines)
    editor.setDecorations(this.prefixDecorationType, [...prefixOptions, ...padOptions]);
  }

  private clearEditorDecorations(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();
    const dts = this.editorToDecorationTypes.get(key);
    if (dts) {
      for (const dt of dts) dt.dispose();
      this.editorToDecorationTypes.delete(key);
    }
  }

  private formatDuration(clockTicks: number): string {
    // Convert from clock ticks to seconds using CLOCKS_PER_SEC
    const seconds = clockTicks / (this.clocksPerSec || 1);
    const ms = seconds * 1000;
    const us = seconds * 1_000_000;

    // Hierarchical display with carry-down of lower units
    if (seconds >= 1) {
      const wholeS = Math.floor(seconds);
      const remainMs = Math.round((seconds - wholeS) * 1000);
      return remainMs > 0 ? `${wholeS}s ${remainMs}ms` : `${wholeS}s`;
    }
    if (ms >= 1) {
      const wholeMs = Math.floor(ms);
      const remainUs = Math.round((ms - wholeMs) * 1000);
      return remainUs > 0 ? `${wholeMs}ms ${remainUs}µs` : `${wholeMs}ms`;
    }
    // fall back to microseconds for very small durations
    const roundedUs = Math.round(us);
    return `${roundedUs}µs`;
  }
}

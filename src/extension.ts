import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from "net";
import { config } from 'process';
import { get } from 'http';

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
      const records = Object.fromEntries(
        Object.entries(parsed.records ?? {}).map(([k, v]) => [path.normalize(k), v as [number, number, number][]])
      ) as Record<string, [number, number, number][]>;
      const clocksPerSec: number = typeof parsed.CLOCKS_PER_SEC === 'number' && isFinite(parsed.CLOCKS_PER_SEC)
        ? parsed.CLOCKS_PER_SEC
        : 1_000_000; // default to microsecond resolution if absent

      // Step 4: Create a decorator to render per-line metrics at line start
      if (currentLineProfiler) {
        try { currentLineProfiler.dispose(); currentLineProfiler.clearReadOnlyConfig() } catch { /* ignore */ }
      }


      currentLineProfiler = new LineProfilerDecorator(context, records, sourceRoot, clocksPerSec);
      context.subscriptions.push(currentLineProfiler);
      const refresh = () => currentLineProfiler?.refreshVisibleEditors();
      context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refresh));
      context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(refresh));
      currentLineProfiler.refreshVisibleEditors();
      vscode.commands.executeCommand('setContext', 'pocketpy.isInProfilerReportMode', true);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load line profiler: ${err.message ?? err}`);
    }
  });
  context.subscriptions.push(loadProfilerCmd);

  const quitProfilerReportMode = vscode.commands.registerCommand("pocketpy.quitProfilerReportMode", async () => {
    if (!currentLineProfiler) {
      vscode.window.showErrorMessage("You are not in profiler mode, cannot quit.")
      return
    }
    await vscode.commands.executeCommand('setContext', 'pocketpy.isInProfilerReportMode', false);
    currentLineProfiler.dispose();
    currentLineProfiler.clearReadOnlyConfig();
    currentLineProfiler = undefined;
  });
  context.subscriptions.push(quitProfilerReportMode);

  vscode.workspace.getConfiguration("files").update("readonlyInclude", {}, vscode.ConfigurationTarget.Workspace);

}

export function deactivate() { }



async function pingserver(host: string, port: number) {
  const msg = 'Content-Length: 44\r\n\r\n{"type":"request","seq":0,"command":"ready"}';
  const start = Date.now();
  const timeout = 60_000; // 10 seconds
  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error("Timeout: server did not respond within 10s");
    }
    try {

      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, host, () => s.write(msg));
        s.once("data", () => { s.end(); resolve(); });
        s.on("error", reject);
      });
      break;
    } catch { await new Promise(r => setTimeout(r, 150)); }
  }
}

class PythonDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.DebugAdapterDescriptor | null> {
    const config = session.configuration;
    const requestType = config.request;
    const port = config.port || DEFAULT_PORT;
    const host = config.host || DEFAULT_HOST;
    if (requestType === 'attach') {
      return new vscode.DebugAdapterServer(port, host);
    }
    if (requestType === 'launch') {
      const program = config.program;
      const args = config.args;
      const terminal = vscode.window.createTerminal({
        name: 'pocketpy',
        cwd: config.cwd
      });
      terminal.sendText(`${program} ${args.join(' ')}`);
      terminal.show();
      await pingserver(host, port);
      return new vscode.DebugAdapterServer(port, host);
    }
    vscode.window.showErrorMessage(`unsupported type: ${requestType}`);
    return null;
  }
}

class PathMappingTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    const sourceFolder = session.configuration.sourceFolder || session.workspaceFolder?.uri.fsPath;

    function toRelativePath(absPath: string): string {
      return path.relative(sourceFolder, absPath);
    }

    function toAbsolutePath(relPath: string): string {
      if (!path.isAbsolute(relPath)) {
        return path.join(sourceFolder, relPath);
      }
      return relPath;
    }

    return {
      onWillReceiveMessage(message) {
        console.log('debugger adpter recv', message);
        if (message.command === 'setBreakpoints' && message.arguments?.source?.path) {
          message.arguments.source.path = toRelativePath(message.arguments.source.path);
        }
      },

      onDidSendMessage(message) {
        console.log('debugger adpter send', message);
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
type LineInfo = { color: string, blockID: number };

class LineProfilerDecorator implements vscode.Disposable {
  // private readonly context: vscode.ExtensionContext;
  private readonly prefixDecorationType: vscode.TextEditorDecorationType;
  private editorToDecorationTypes: Map<string, vscode.TextEditorDecorationType[]> = new Map();
  private editorToColors: Map<string, Map<number, LineInfo>> = new Map();
  private analysisFilesSet: Set<string> = new Set();

  constructor(
    context: vscode.ExtensionContext,
    private readonly data: Record<string, Array<[number, number, number]>>, // relPath -> [line, hits, time]
    private readonly sourceRoot: string,
    private readonly clocksPerSec: number
  ) {
    // this.context = context;
    // Prefix percentage before the code; fixed styling (not theme-driven)
    this.prefixDecorationType = vscode.window.createTextEditorDecorationType({});
    const currentInclude: { [key: string]: boolean } = vscode.workspace.getConfiguration("files").get("readonlyInclude", {});
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? sourceRoot
    for (const filepath of Object.keys(this.data)) {
      const pathPrefix = path.relative(workspacePath, sourceRoot);
      const analysisFilesPath = path.join(pathPrefix, filepath).replace(/\\/g, '/');
      currentInclude[analysisFilesPath] = true;
      this.analysisFilesSet.add(analysisFilesPath);
    }
    vscode.workspace.getConfiguration("files").update("readonlyInclude", currentInclude, vscode.ConfigurationTarget.Workspace);
  }


  dispose(): void {
    this.prefixDecorationType.dispose();
    for (const dts of this.editorToDecorationTypes.values()) {
      for (const dt of dts) dt.dispose();
    }
    this.editorToDecorationTypes.clear();
  }

  refreshVisibleEditors(): void {
    if (!currentLineProfiler) {
      return
    }
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {

      if (editor.document.languageId === 'python') {
        this.applyToEditor(editor);
      }
    }
  }

  private getBlockColors(): string[] {
    return [
      "#9C27B0",
      "#2196F3",
      "#4CAF50",
      "#FF9800",
      "#F44336",
    ];
  }


  private async mapLinesToBlocks(editor: vscode.TextEditor): Promise<Map<number, LineInfo>> {
    const cached = this.editorToColors.get(editor.document.uri.toString());
    if (cached) return cached;

    const lineMap = new Map<number, LineInfo>();
    const foldRanges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      editor.document.uri
    ) ?? [];

    const colors = this.getBlockColors();
    const endStack: number[] = [editor.document.lineCount];
    lineMap.set(endStack[0], { color: colors[0], blockID: 0 });
    let nextBlockId = 1;
    for (const fr of foldRanges) {
      const lineText = editor.document.lineAt(fr.start).text.trimStart();
      if (!lineText.startsWith('def ')) continue;
      while (fr.start > endStack[endStack.length - 1]) {
        endStack.pop();
      }
      const color = colors[endStack.length % colors.length];
      const parentID = lineMap.get(endStack[endStack.length - 1])?.blockID!;
      const parentColor = lineMap.get(endStack[endStack.length - 1])?.color!;

      for (let line = fr.start; line <= fr.end; line++) {
        lineMap.set(line + 1, {
          color: line == fr.start ? parentColor : color,
          blockID: line == fr.start ? parentID : nextBlockId,
        });
      }
      endStack.push(fr.end);
      nextBlockId++;
    }
    this.editorToColors.set(editor.document.uri.toString(), lineMap);
    return lineMap;
  }

  private generateBackgroundColor(ratio: number): string {
    const alpha = +(ratio * 0.8).toFixed(2);
    const hue = 210;
    const saturation = 60;
    const lightness = 65;

    return `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
  }

  private createHoverMessage(percent: number, time: number, hits: number): vscode.MarkdownString {
    const hover = new vscode.MarkdownString(`${percent}% — ${this.formatDuration(time)} • ${hits} hits`);
    hover.isTrusted = false;
    return hover;
  }

  private createLineDecoration(line: number, hover: vscode.MarkdownString): vscode.DecorationOptions {
    return {
      range: new vscode.Range(line - 1, 0, line - 1, 0),
      hoverMessage: hover
    };
  }

  private createPrefixDecoration(line: number, percent: number, blockColor: string): vscode.DecorationOptions {
    // zero width spcae to void fold
    const label = `${String(percent).padStart(3, ' ')}%`
    const textColor = percent == 0 ? '#888888' : '#f0f0f0';
    return {
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
            `border-right:10px solid ${blockColor}`,
          ].join(';')
        }
      }
    };
  }

  private createPaddingDecoration(line: number): vscode.DecorationOptions {
    return {
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: {
        before: {
          contentText: '',
          margin: '0 8px 0 0',
          width: '50px',
          textDecoration: ['display:inline-block', 'box-sizing:border-box', 'padding-right:6px'].join(';')
        }
      }
    };
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    colorToOptions: Map<string, vscode.DecorationOptions[]>,
    prefixOptions: vscode.DecorationOptions[]
  ) {
    editor.setDecorations(this.prefixDecorationType, []);
    this.clearEditorDecorations(editor);

    const createdDts: vscode.TextEditorDecorationType[] = [];
    for (const [color, options] of colorToOptions.entries()) {
      const dt = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: color });
      createdDts.push(dt);
      editor.setDecorations(dt, options);
    }
    this.editorToDecorationTypes.set(editor.document.uri.toString(), createdDts);

    editor.setDecorations(this.prefixDecorationType, prefixOptions);
  }

  private async applyToEditor(editor: vscode.TextEditor): Promise<void> {
    const relPath = path
      .normalize(path.relative(this.sourceRoot, editor.document.uri.fsPath))
    const records = this.data[relPath];
    if (!records || records.length === 0) {
      editor.setDecorations(this.prefixDecorationType, []);
      this.clearEditorDecorations(editor);
      return;
    }

    const blockLevels = await this.mapLinesToBlocks(editor);
    const blockTimes = new Map<number, number>();

    for (const [line, , time] of records) {
      const blockInfo = blockLevels.get(line) ?? { color: this.getBlockColors()[0], blockID: 0 };
      let blockTime = blockTimes.get(blockInfo.blockID) ?? 0
      blockTime += time
      blockTimes.set(blockInfo.blockID, blockTime)
    }

    const colorToOptions: Map<string, vscode.DecorationOptions[]> = new Map();
    const prefixOptions: vscode.DecorationOptions[] = [];
    const coveredLines = new Set<number>();

    for (const [line, hits, time] of records) {
      const blockInfo = blockLevels.get(line) ?? { color: this.getBlockColors()[0], blockID: 0 };
      const totalTime = blockTimes.get(blockInfo.blockID)!;
      const ratio = time / totalTime || 0;
      const percent = Math.round(ratio * 100);

      const color = this.generateBackgroundColor(ratio);
      const hover = this.createHoverMessage(percent, time, hits);
      const option = this.createLineDecoration(line, hover);

      if (!colorToOptions.has(color)) colorToOptions.set(color, []);
      colorToOptions.get(color)!.push(option);

      prefixOptions.push(this.createPrefixDecoration(line, percent, blockInfo.color));
      coveredLines.add(line - 1);
    }
    const totalLines = editor.document.lineCount;
    for (let i = 0; i < totalLines; i++) {
      if (!coveredLines.has(i)) prefixOptions.push(this.createPaddingDecoration(i));
    }
    this.applyDecorations(editor, colorToOptions, prefixOptions);
  }


  private clearEditorDecorations(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();
    const dts = this.editorToDecorationTypes.get(key);
    if (dts) {
      for (const dt of dts) dt.dispose();
      this.editorToDecorationTypes.delete(key);
    }
  }

  public async clearReadOnlyConfig(): Promise<void> {
    const currentInclude: { [key: string]: boolean } = vscode.workspace.getConfiguration("files").get("readonlyInclude", {});
    for (const path of this.analysisFilesSet) {
      currentInclude[path] = false;
    }
    await vscode.workspace.getConfiguration("files").update("readonlyInclude", currentInclude, vscode.ConfigurationTarget.Workspace);
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

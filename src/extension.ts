import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const DEBUG_TYPE = 'python-debug';
const DEFAULT_PORT = 3939;
const DEFAULT_HOST = 'localhost';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new PythonDebugAdapterDescriptorFactory())
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new PathMappingTrackerFactory())
  );
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
    if (requestType === 'attach') {
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
      }
    };
  }
}


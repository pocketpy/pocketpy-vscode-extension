// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from "child_process";
import * as fs from 'fs';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('python-debug', {
      createDebugAdapterDescriptor: (session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable) => {
        // 获取用户的配置
        const config = session.configuration;
        const requestType = config.request; // "launch" 或 "attach"
        
        // 根据不同的请求类型做出不同的处理
        if (requestType === 'launch') {
          // 获取程序路径和端口
          const programPath = config.program;
          const port = config.port || 3939;
          const host = config.host || 'localhost';
          
          // 检查程序路径
          if (!programPath) {
            vscode.window.showErrorMessage('未指定要调试的程序路径');
            return Promise.reject(new Error('未指定要调试的程序路径'));
          }
          
          // 检查文件是否存在
          if (!fs.existsSync(programPath)) {
            vscode.window.showErrorMessage(`找不到程序文件: ${programPath}`);
            return Promise.reject(new Error(`找不到程序文件: ${programPath}`));
          }
          
          // 在终端中直接启动被调试程序
          // 注意：程序需要自行导入 debug_adapter 并调用 wait_for_client(port)
          const terminal = vscode.window.createTerminal('Python Debug');
          terminal.show();
          
          // 构建命令行参数
          const args = config.args ? ' ' + config.args.join(' ') : '';
          terminal.sendText(`python "${programPath}"${args}`);
          
          // 延迟返回，确保程序有时间启动并开始监听端口
          return new Promise<vscode.DebugAdapterServer>((resolve) => {
            setTimeout(() => {
              resolve(new vscode.DebugAdapterServer(port, host));
            }, 2000);
          });
        } 
        else if (requestType === 'attach') {
          // 获取端口和主机
          const port = config.port || 3939;
          const host = config.host || 'localhost';
          
          // attach 模式下，假设程序已经运行并已调用 wait_for_client()
          // 直接返回调试适配器服务器实例
          return Promise.resolve(new vscode.DebugAdapterServer(port, host));
        }
        else {
          // 不支持的请求类型
          vscode.window.showErrorMessage(`不支持的调试请求类型: ${requestType}`);
          return Promise.reject(new Error(`不支持的调试请求类型: ${requestType}`));
        }
      }
    })
  );
  
  vscode.debug.registerDebugAdapterTrackerFactory('python-debug', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      return {
        // 捕获从调试适配器发送到客户端的消息
        onDidSendMessage: (message) => {
          console.log('→ From DA:', JSON.stringify(message));
        },
        // 捕获从客户端发送到调试适配器的消息
        onWillReceiveMessage: (message) => {
          console.log('← To DA:', JSON.stringify(message));
        }
      };
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}

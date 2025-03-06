#!/usr/bin/env python3
import sys
import os
import json
import socket
import logging
import argparse
import time
import traceback
import re
import threading
import runpy
import pathlib
import select
# 设置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("debug_adapter.log",'w',encoding='utf-8'),
        logging.StreamHandler(sys.stderr)
    ]
)
logger = logging.getLogger("DebugAdapter")

# 序列号计数器
seq_counter = 0

def get_next_seq():
    global seq_counter
    seq_counter += 1
    return seq_counter

class SimpleDebugAdapter:
    def __init__(self, host='127.0.0.1', port=0):
        self.host = host
        self.port = port
        self.server_socket = None
        self.client_socket = None
        self.running = False
        self.step_mode = None 
        # 断点存储
        self.breakpoints = {}  # 文件路径 -> {行号 -> 断点信息}
        
        # 当前调试状态
        self.suspended = False
        self.current_frame = None
        self.frames = []
        self.frame_vars = {}
        self.var_refs = {}
        self.next_var_ref = 1 # 每个作用域(变量)的唯一ID,0代表该作用域(变量)没有子作用域
        
        # 作用域引用 - 每个帧都有自己的局部和全局作用域引用
        self.scope_refs = {}  # frame_id -> {scope_type -> ref_id}
        
        # 消息缓冲区
        self.message_buffer = b''
        self.message_content_length = -1
    
    def start(self):
        """启动调试适配器"""
        # 创建套接字服务器
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(1)
        
        _, self.port = self.server_socket.getsockname()
        logger.info(f"调试适配器启动在 {self.host}:{self.port}")
        
        port_message = {
            "port": self.port,
            "host": self.host
        }
        sys.stdout.flush()
        
        # 接受客户端连接
        logger.info("等待客户端连接...")
        self.client_socket, client_address = self.server_socket.accept()
        logger.info(f"客户端已连接: {client_address}")
        
        # 开始消息循环 - 处理初始命令
        self.running = True
        self.initial_message_loop()
    
    def initial_message_loop(self):
        """初始化阶段的消息循环 - 处理命令直到配置完成"""
        buffer = b''
        content_length = -1
        header_pattern = re.compile(b'Content-Length: (\\d+)\\r\\n\\r\\n')
        
        # 设置跟踪函数 - 在连接后立即设置
        sys.settrace(self._trace_func)
        
        # 发送线程启动事件
        self.send_event('thread', {'reason': 'started', 'threadId': 1})
        
        # 标记是否完成初始化配置
        config_done = False
        
        # 处理消息直到收到 configurationDone 命令
        while self.running and not config_done:
            try:
                # 接收数据
                data = self.client_socket.recv(4096)
                if not data:
                    logger.info("客户端已断开连接")
                    self.running = False
                    break
                
                buffer += data
                
                # 处理所有完整的消息
                while True:
                    # 如果还没有解析出内容长度，尝试从缓冲区中解析
                    if content_length < 0:
                        match = header_pattern.search(buffer)
                        if not match:
                            # 没有找到完整的头部，等待更多数据
                            break
                        
                        # 提取内容长度
                        content_length = int(match.group(1))
                        
                        # 移除头部
                        header_end = match.end()
                        buffer = buffer[header_end:]
                    
                    # 检查是否有足够的数据
                    if len(buffer) < content_length:
                        # 需要更多数据
                        break
                    
                    # 提取消息内容
                    message_data = buffer[:content_length]
                    buffer = buffer[content_length:]
                    
                    # 重置内容长度
                    content_length = -1
                    
                    # 解析并处理消息
                    try:
                        message = json.loads(message_data.decode('utf-8'))
                        
                        # 处理消息
                        self.process_message(message)
                        
                        # 如果收到 configurationDone 命令，退出循环
                        if message.get('command') == 'configurationDone':
                            logger.info("收到 configurationDone 命令，完成初始化阶段")
                            config_done = True
                            break
                        
                    except json.JSONDecodeError:
                        logger.error(f"无法解析 JSON: {message_data}")
            
            except Exception as e:
                logger.error(f"消息循环错误: {e}")
                traceback.print_exc()
                self.running = False
                break
        
        # 离开初始化阶段，现在 _trace_func 将接管控制
        logger.info("初始化阶段完成，等待调试事件...")
        
    
    def stop(self):
        """停止调试适配器"""
        self.running = False
        
        if self.client_socket:
            try:
                self.client_socket.close()
            except:
                pass
            self.client_socket = None
        
        if self.server_socket:
            try:
                self.server_socket.close()
            except:
                pass
            self.server_socket = None
        
        logger.info("调试适配器已停止")
    
    def send_message(self, message):
        """发送消息到客户端"""
        if not self.client_socket:
            logger.error("没有连接的客户端")
            return
        
        try:
            # 将消息转换为 JSON
            message_json = json.dumps(message)
            message_bytes = message_json.encode('utf-8')
            
            # 添加 DAP 协议头部
            header = f"Content-Length: {len(message_bytes)}\r\n\r\n"
            header_bytes = header.encode('utf-8')
            
            # 发送消息
            self.client_socket.sendall(header_bytes + message_bytes)
            logger.debug(f"发送消息: {message}")
        except Exception as e:
            logger.error(f"发送消息错误: {e}")
    
    def send_response(self, request, body=None):
        """发送响应"""
        response = {
            'type': 'response',
            'request_seq': request.get('seq', 0),
            'success': True,
            'command': request.get('command', ''),
            'seq': get_next_seq()
        }
        
        if body:
            response['body'] = body
        
        self.send_message(response)
    
    def send_event(self, event, body=None):
        """发送事件"""
        message = {
            'type': 'event',
            'event': event,
            'seq': get_next_seq()
        }
        
        if body:
            message['body'] = body
        
        self.send_message(message)
    
    def process_message(self, message):
        """处理接收到的消息"""
        logger.debug(f"收到消息: {message}")
        
        if message.get('type') != 'request':
            return False
        
        command = message.get('command')
        if not command:
            return False
        
        # 处理各种请求
        handler_name = f"handle_{command}"
        handler = getattr(self, handler_name, None)
        
        if handler:
            try:
                response_body = handler(message)
                self.send_response(message, response_body)
                return True
            except Exception as e:
                logger.error(f"处理命令 {command} 错误: {e}")
                traceback.print_exc()
                self.send_response(message, {'error': str(e)})
                return False
        else:
            logger.warning(f"未实现的命令: {command}")
            self.send_response(message, {'error': f"未实现的命令: {command}"})
            return False
    
    def receive_message(self):
        """尝试接收一个调试消息 - 在 trace 函数中调用"""
        if not self.client_socket:
            return None
        
        try:
            # 检查是否有消息可接收
            ready, _, _ = select.select([self.client_socket], [], [], 0)
            if ready:
                # 读取可用数据并添加到缓冲区
                chunk = self.client_socket.recv(4096)
                if not chunk:
                    # 连接已关闭
                    self.running = False
                    return None
                
                # 将新数据添加到现有缓冲区
                self.message_buffer += chunk
            
            # 解析头部和消息体
            header_pattern = re.compile(b'Content-Length: (\\d+)\\r\\n\\r\\n')
            
            # 处理缓冲区中的消息
            while True:
                # 尝试解析内容长度
                if self.message_content_length < 0:
                    match = header_pattern.search(self.message_buffer)
                    if not match:
                        # 头部不完整，等待更多数据
                        return None
                    
                    # 提取内容长度
                    self.message_content_length = int(match.group(1))
                    
                    # 移除头部
                    header_end = match.end()
                    self.message_buffer = self.message_buffer[header_end:]
                
                # 检查是否有足够的数据用于消息体
                if len(self.message_buffer) < self.message_content_length:
                    # 消息体不完整，等待更多数据
                    return None
                
                # 提取完整消息
                message_data = self.message_buffer[:self.message_content_length]
                
                # 更新缓冲区，移除已处理的消息
                self.message_buffer = self.message_buffer[self.message_content_length:]
                
                # 重置内容长度，准备解析下一条消息
                self.message_content_length = -1
                
                # 解析消息
                return json.loads(message_data.decode('utf-8'))
                
        except Exception as e:
            logger.error(f"接收消息错误: {e}")
            traceback.print_exc()
            return None
    
    # 命令处理程序
    
    def handle_initialize(self, request):
        """处理初始化请求"""
        capabilities = {
            'supportsConfigurationDoneRequest': True,
            'supportsEvaluateForHovers': False,
            'supportsStepBack': False,
            'supportsSetVariable': False,
            'supportsRestartFrame': False,
            'supportsGotoTargetsRequest': False,
            'supportsStepInTargetsRequest': False,
            'supportsCompletionsRequest': False,
            'supportsModulesRequest': False,
            'supportsExceptionOptions': False,
            'supportsValueFormattingOptions': False,
            'supportsExceptionInfoRequest': False,
            'supportTerminateDebuggee': True,
            'supportsDelayedStackTraceLoading': False,
            'supportsLogPoints': False,
            'supportsConditionalBreakpoints': False
        }
        
        # 发送初始化事件
        self.send_event('initialized')
        
        return capabilities
    
    def handle_launch(self, request):
        """处理launch请求"""
        args = request.get('arguments', {})
        self.program = args.get('program')
        self.program_args = args.get('args', [])
        
        # 在 attach 模式下，我们只需记录程序路径，不需要启动程序
        if self.program:
            self.program = os.path.normcase(os.path.normpath(self.program))
        
        logger.info(f"收到 launch 请求，程序路径: {self.program}")
        return {}

    def handle_attach(self,request):
        """处理attach请求""" 
        return {}
    
    
    def handle_setBreakpoints(self, request):
        """处理设置断点请求"""
        args = request.get('arguments', {})
        source = args.get('source', {})
        breakpoints = args.get('breakpoints', [])
        source_path = source.get('path')
        source_path = os.path.normcase(os.path.normpath(source_path)) 
        if not source_path:
            raise Exception("缺少源文件路径")
        
        # 清除该文件中的所有断点
        if source_path in self.breakpoints:
            del self.breakpoints[source_path]
        
        self.breakpoints[source_path] = {}
        
        # 添加新断点
        actual_breakpoints = []
        for i, bp in enumerate(breakpoints):
            line = bp.get('line')
            
            # 保存断点信息
            self.breakpoints[source_path][line] = {'id': i + 1}
            
            # 返回断点信息
            actual_breakpoints.append({
                'id': i + 1,
                'verified': True,
                'line': line
            })
        
        logger.info(f"设置断点: {source_path} - {list(self.breakpoints[source_path].keys())}")
        return {'breakpoints': actual_breakpoints}
    
    def handle_configurationDone(self, request):
        """处理配置完成请求"""
        logger.info("配置完成，开始运行程序")
        return {}
    
    def handle_threads(self, request):
        """处理线程请求"""
        # 简化：只有一个线程
        threads = [{'id': 1, 'name': 'thread1'}]
        return {'threads': threads}
    
    def handle_stackTrace(self, request):
        """处理堆栈跟踪请求"""
        return {
            'stackFrames': self.frames,
            'totalFrames': len(self.frames)
        }
    
    def handle_scopes(self, request):
        """处理作用域请求"""
        args = request.get('arguments', {})
        frame_id = args.get('frameId', 1)
        
        # 如果该帧没有作用域引用，创建新的
        if frame_id not in self.scope_refs:
            # 为该帧创建局部和全局作用域引用
            local_ref = self.next_var_ref
            self.next_var_ref += 1
            global_ref = self.next_var_ref
            self.next_var_ref += 1
            
            self.scope_refs[frame_id] = {
                'local': local_ref,
                'global': global_ref
            }
            
            # 将作用域引用关联到对应帧
            self.var_refs[local_ref] = ('frame_locals', frame_id)
            self.var_refs[global_ref] = ('frame_globals', frame_id)
        
        # 获取该帧的作用域引用
        scope_refs = self.scope_refs[frame_id]
        
        # 返回作用域信息
        scopes = [
            {
                'name': '局部变量',
                'presentationHint': 'locals',
                'variablesReference': scope_refs['local'],
                'expensive': False
            },
            {
                'name': '全局变量',
                'presentationHint': 'globals',
                'variablesReference': scope_refs['global'],
                'expensive': True
            }
        ]
        
        return {'scopes': scopes}
    
    def handle_variables(self, request):
        """处理变量请求"""
        args = request.get('arguments', {})
        var_ref = args.get('variablesReference', 0)
        
        variables = []
        
        if var_ref in self.var_refs:
            ref_type = self.var_refs[var_ref]
            
            # 处理帧局部变量
            if isinstance(ref_type, tuple) and ref_type[0] == 'frame_locals':
                frame_id = ref_type[1]
                frame = self.frame_vars.get(frame_id)
                
                if frame:
                    # 获取局部变量
                    for name, value in frame.f_locals.items():
                        variables.append(self._create_variable(name, value, frame_id))
            
            # 处理帧全局变量
            elif isinstance(ref_type, tuple) and ref_type[0] == 'frame_globals':
                frame_id = ref_type[1]
                frame = self.frame_vars.get(frame_id)
                
                if frame:
                    # 获取全局变量
                    for name, value in frame.f_globals.items():
                        if name not in frame.f_locals:  # 避免与局部变量重复
                            variables.append(self._create_variable(name, value, frame_id))
            
            # 处理复合对象变量
            else:
                obj = ref_type
                
                # 列表或元组
                if isinstance(obj, (list, tuple)):
                    for i, item in enumerate(obj):
                        variables.append(self._create_variable(f"[{i}]", item))
                
                # 字典
                elif isinstance(obj, dict):
                    for key, value in obj.items():
                        variables.append(self._create_variable(str(key), value))
                
                # 其他复合对象
                elif hasattr(obj, '__dict__'):
                    for name, value in obj.__dict__.items():
                        if not name.startswith('_'):  # 跳过私有属性
                            variables.append(self._create_variable(name, value))
        
        return {'variables': variables}
    
    def handle_continue(self, request):
        """处理继续请求"""
        self.suspended = False
        return {'allThreadsContinued': True}
    
    def handle_next(self, request):
        """处理下一步请求"""
        self.step_mode = 'next'
        self.step_frame = self.current_frame
        self.suspended = False
        return {}
    
    def handle_stepIn(self, request):
        """处理步入请求"""
        self.step_mode = 'step'
        self.suspended = False
        return {}
    
    def handle_disconnect(self, request):
        """处理断开连接请求"""
        self.running = False
        return {}
    
    # 内部调试方法
    
    def _trace_func(self, frame, event, arg):
        """跟踪函数，处理调试事件"""
        if not self.running:
            return None
        
        # 如果暂停状态，处理命令
        if self.suspended:
            # 尝试接收并处理消息
            while self.suspended and self.running:
                message = self.receive_message()
                if message:
                    self.process_message(message)
                else:
                    time.sleep(0.01)
        # 获取当前文件和行号
        filename = os.path.abspath(frame.f_code.co_filename)
        lineno = frame.f_lineno
        filename = os.path.normcase(os.path.normpath(filename))
        # 处理不同的事件类型
        if event == 'line':
            # 检查是否应该在此行停止
            should_break = self._should_break(filename, lineno)
            if should_break:
                self._suspend_execution(frame, 'breakpoint')
            
            # 处理单步执行
            elif self.step_mode == 'step':
                self._suspend_execution(frame, 'step')
                self.step_mode = None
            
            # 处理下一步执行
            elif self.step_mode == 'next' and frame is self.step_frame:
                self._suspend_execution(frame, 'step')
                self.step_mode = None
        
        # 继续使用相同的跟踪函数
        return self._trace_func
    
    def _should_break(self, filename, lineno):
        """检查是否应该在当前行停止"""
        # 检查文件是否有断点
        if filename in self.breakpoints:
            # 检查行号是否有断点
            if lineno in self.breakpoints[filename]:
                logger.info(f"断点触发: {filename}:{lineno}")
                return True
        
        return False
    
    def _suspend_execution(self, frame, reason):
        """暂停执行"""
        if self.suspended:
            return
        
        self.suspended = True
        self.current_frame = frame
        
        # 保存堆栈帧
        self.frames = self._get_stack_frames(frame)
        
        # 发送停止事件
        self.send_event('stopped', {
            'reason': reason,
            'threadId': 1,
            'allThreadsStopped': True,
        })
        
        # 在 _trace_func 中处理消息，直到恢复执行
    
    def _get_stack_frames(self, frame):
        """获取堆栈帧信息"""
        frames = []
        frame_id = 1
        
        # 遍历堆栈帧
        current = frame
        while current:
            filename = os.path.abspath(current.f_code.co_filename)
            
            # 创建帧信息
            frame_info = {
                'id': frame_id,
                'name': current.f_code.co_name or '<module>',
                'source': {
                    'name': os.path.basename(filename),
                    'path': filename
                },
                'line': current.f_lineno,
                'column': 0
            }
            
            frames.append(frame_info)
            
            # 保存帧变量引用
            self.frame_vars[frame_id] = current
            
            current = current.f_back
            frame_id += 1
        
        return frames
    
    def _create_variable(self, name, value, frame_id=None):
        """创建变量信息"""
        var_type = type(value).__name__
        
        try:
            # 尝试安全地转换为字符串
            var_value = str(value)
            if len(var_value) > 1000:
                var_value = var_value[:1000] + "..."
        except:
            var_value = "<无法显示的值>"
        
        var_ref = 0
        
        # 对于复合类型，创建变量引用
        if isinstance(value, (dict, list, tuple)) and len(value) > 0:
            var_ref = self.next_var_ref
            self.var_refs[var_ref] = value
            self.next_var_ref += 1
        # 对于其他有属性的对象
        elif hasattr(value, '__dict__') and value.__dict__:
            var_ref = self.next_var_ref
            self.var_refs[var_ref] = value
            self.next_var_ref += 1
        
        return {
            'name': name,
            'value': var_value,
            'type': var_type,
            'variablesReference': var_ref
        }

def wait_for_client(port=3939):
    """等待调试客户端连接（在被调试程序中调用此函数）"""
    try:
        adapter = SimpleDebugAdapter(host='localhost', port=port)
        adapter.start()
    except KeyboardInterrupt:
        logger.info("收到中断信号，正在停止...")
    except Exception as e:
        logger.error(f"发生错误: {e}", exc_info=True)
        sys.exit(1)


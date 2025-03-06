

import sys
import os


project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# 添加到 Python 路径
sys.path.append(project_root)

from python import debug_adapter


def factorial(n):
    if n <= 1:
        return 1
    else:
        return n * factorial(n-1)

class test:
    def __init__(self):
        self.name = "hello"
        self.id = 10

def main():
    # 等待调试器连接 (VSCode 启动调试时会设置 DEBUG_ADAPTER_PORT 环境变量)
    
    print("开始测试")
    
    # 测试变量
    x = 10
    y = 20
    z = x + y
    t = test()
    # 测试列表和字典
    my_list = [1, 2, 3, 4, 5]
    my_dict = {"name": "测试", "value": 42}
    
    # 测试函数调用
    result = factorial(5)
    print(f"5的阶乘是: {result}")
    
    print("测试结束")

if __name__ == "__main__":
    debug_adapter.wait_for_client()
    main() 
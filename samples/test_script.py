

def factorial(n):
    if n <= 1:
        return 1
    else:
        return n * factorial(n-1)

class test:
    def __init__(self):
        self.name = "hello\n123"
        self.id = 10

def main():
    # Wait for debugger connection 
    # (VSCode will set DEBUG_ADAPTER_PORT environment variable when starting debug session)
    
    print("Starting test...")
    
    # Test variables
    x = 10
    y = 20
    z = x + y
    # Test list and dictionary
    my_list = [i for i in range(10)]
    my_dict = {"name": "test", "value": 42}
    
    # Test function call
    t = test()
    result = factorial(5)
    print(f"Factorial of 5 is: {result}")
    
    print("Test completed")

main()
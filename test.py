#make an interface for a calculator that can perform addition, subtraction, multiplication, and division
import sys

def calculator():
    while True:
        print("Enter operation (+, -, *, /):")
        operation = input().strip()
        if operation not in ['+', '-', '*', '/']:
            print("Invalid operation. Please try again.")
            continue

        print("Enter two numbers:")
        num1 = float(input().strip())
        num2 = float(input().strip())

        if operation == '+':
            result = num1 + num2
        elif operation == '-':
            result = num1 - num2
        elif operation == '*':
            result = num1 * num2
        elif operation == '/':
            if num2 == 0:
                print("Error: Division by zero.")
                continue
            result = num1 / num2

        print(f"Result: {result}")

if __name__ == "__main__":
    calculator()
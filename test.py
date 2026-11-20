#make a while loop
def main():
    while True:
        user_input = input("Enter something: ")
        if user_input == "exit":
            break
        print("You entered:", user_input)

if __name__ == "__main__":
    main()
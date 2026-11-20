"""Original C++20 supervision and held-out fixtures, dedicated to CC0-1.0."""

LICENSE = "CC0-1.0"

# Header, argument type, operation, and implementation. Test operation families
# are authored separately from these examples.
FUNCTIONS = (
    ("algorithm", "std::vector<int>", "Sort {x} in descending order",
     "std::sort({x}.begin(), {x}.end(), std::greater<int>{{}});", "{x}"),
    ("numeric", "std::vector<int>", "Sum the integers in {x}",
     "const int total = std::accumulate({x}.begin(), {x}.end(), 0);", "total"),
    ("algorithm", "std::string", "Reverse the characters in {x}",
     "std::reverse({x}.begin(), {x}.end());", "{x}"),
    ("algorithm", "std::string", "Replace underscores in {x} with spaces",
     "std::replace({x}.begin(), {x}.end(), '_', ' ');", "{x}"),
    ("algorithm", "std::vector<int>", "Remove negative numbers from {x}",
     "std::erase_if({x}, [](int number) {{ return number < 0; }});", "{x}"),
    ("algorithm", "std::vector<int>", "Count zero entries in {x}",
     "const auto count = std::count({x}.begin(), {x}.end(), 0);", "count"),
    ("algorithm", "std::vector<int>", "Check if all entries in {x} are positive",
     "const bool positive = std::all_of({x}.begin(), {x}.end(), [](int n) {{ return n > 0; }});",
     "positive"),
    ("algorithm", "std::vector<int>", "Rotate {x} left by one if it is nonempty",
     "if (!{x}.empty()) std::rotate({x}.begin(), {x}.begin() + 1, {x}.end());", "{x}"),
    ("algorithm", "std::vector<int>", "Check if {x} holds any even integer",
     "const bool found = std::any_of({x}.begin(), {x}.end(), [](int n) {{ return n % 2 == 0; }});",
     "found"),
    ("numeric", "std::vector<int>", "Multiply the integers in {x}",
     "const auto product = std::accumulate({x}.begin(), {x}.end(), 1, std::multiplies<int>{{}});",
     "product"),
    ("algorithm", "std::vector<int>", "Find the smallest integer in nonempty {x}",
     "const int minimum = *std::min_element({x}.begin(), {x}.end());", "minimum"),
    ("string", "std::string", "Test whether {x} starts with https://",
     'const bool secure = {x}.starts_with("https://");', "secure"),
    ("string", "std::string", "Test whether {x} ends with .csv",
     'const bool csv = {x}.ends_with(".csv");', "csv"),
    ("string", "std::string", "Extract the first four characters of {x}",
     "const auto prefix = {x}.substr(0, 4);", "prefix"),
    ("vector", "std::vector<int>", "Remove the final entry of {x} if present",
     "if (!{x}.empty()) {x}.pop_back();", "{x}"),
    ("vector", "std::vector<int>", "Append two copies of seven to {x}",
     "{x}.insert({x}.end(), 2, 7);", "{x}"),
    ("algorithm", "std::vector<int>", "Check if {x} is sorted in ascending order",
     "const bool sorted = std::is_sorted({x}.begin(), {x}.end());", "sorted"),
    ("algorithm", "std::vector<int>", "Remove adjacent duplicates from {x}",
     "{x}.erase(std::unique({x}.begin(), {x}.end()), {x}.end());", "{x}"),
    ("algorithm", "std::vector<int>", "Set all elements of {x} to 42",
     "std::fill({x}.begin(), {x}.end(), 42);", "{x}"),
    ("numeric", "std::vector<int>", "Overwrite {x} with integers starting at 100",
     "std::iota({x}.begin(), {x}.end(), 100);", "{x}"),
    ("algorithm", "std::vector<int>", "Put all even elements of {x} first, preserving relative order",
     "std::stable_partition({x}.begin(), {x}.end(), [](int n) {{ return n % 2 == 0; }});", "{x}"),
    ("algorithm", "int", "Limit {x} to the inclusive interval from 5 to 80",
     "const int bounded = std::clamp({x}, 5, 80);", "bounded"),
    ("bit", "unsigned", "Count the set bits in {x}",
     "const int bits = std::popcount({x});", "bits"),
    ("map", "std::map<int, int>", "Check whether key 42 is present in {x}",
     "const bool has_key = {x}.contains(42);", "has_key"),
)


def training_rows(role):
    for i, (header, arg_type, instruction, statement, result) in enumerate(FUNCTIONS):
        for j, var in enumerate(("items", "input", "values", "data")):
            name = f"task_{i}_{j}"
            description = instruction.format(x=var)
            signature = f"auto {name}({arg_type} {var})"
            headers = "".join(f"#include <{h}>\n" for h in sorted({header, "functional", "vector", "string"}))
            body = statement.format(x=var)
            tail = f"\n    return {result.format(x=var)};\n}}"
            if role == "chat":
                yield {"license": LICENSE, "prompt": f"Write C++20 code for {signature}. {description}.",
                       "expected": f"{headers}\n{signature} {{\n    {body}{tail}\n"}
            else:
                prefix = f"{headers}\n{signature} {{\n    // {description}\n    "
                if j == 3 and " = " in body:
                    declaration, body = body.split(" = ", 1)
                    prefix += declaration + " = "
                yield {"license": LICENSE, "prompt": prefix, "expected": body, "suffix": tail}


# Each fixture runs assertions against a completed translation unit.
FIM = (
    ("#include <cmath>\nint magnitude(int n) {\n    // Return the absolute value of n\n    ",
     "\n}\n", "return std::abs(n);", "magnitude(-3) == 3 && magnitude(8) == 8"),
    ("#include <bit>\nbool has_one_bit(unsigned mask) {\n    return ",
     ";\n}\n", "std::has_single_bit(mask)", "has_one_bit(64) && !has_one_bit(0) && !has_one_bit(3)"),
    ("#include <numeric>\nint divisor(int a, int b) {\n    // Greatest common divisor\n    ",
     "\n}\n", "return std::gcd(a, b);", "divisor(28, 12) == 4 && divisor(9, 0) == 9"),
    ("#include <algorithm>\n#include <vector>\nbool has_three(const std::vector<int>& seq) {\n    ",
     "\n}\n", "return std::find(seq.begin(), seq.end(), 3) != seq.end();",
     "has_three({1, 3, 7}) && !has_three({}) && !has_three({6, 7})"),
    ("#include <string>\nstd::string labelled(int count) {\n    // Return qty= followed by the count\n    ",
     "\n}\n", 'return "qty=" + std::to_string(count);', 'labelled(7) == "qty=7" && labelled(-4) == "qty=-4"'),
    ("#include <cstdint>\nstd::uint16_t high_byte(std::uint16_t word) {\n    // Shift right by eight bits\n    ",
     "\n}\n", "return word >> 8;", "high_byte(0xABCD) == 0xAB && high_byte(0xFF) == 0"),
)

CHAT = (
    ("Implement bool leap_year(int year), using the Gregorian rules.",
     "bool leap_year(int year) { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0); }",
     "leap_year(2000) && leap_year(2024) && !leap_year(1900) && !leap_year(2023)"),
    ("Write a C++ function int triangular(int n) that returns the sum from 1 through n. Return zero if n is negative.",
     "int triangular(int n) { return n > 0 ? n * (n + 1) / 2 : 0; }",
     "triangular(5) == 15 && triangular(-2) == 0 && triangular(0) == 0"),
    ("Implement std::string basename_of(const std::string& path). Return the part after the last slash or the whole string if there is no slash.",
     '#include <string>\nstd::string basename_of(const std::string& path) { return path.substr(path.rfind(\'/\') + 1); }',
     'basename_of("/tmp/entry") == "entry" && basename_of("abc") == "abc" && basename_of("/tmp/").empty()'),
    ("Implement int signum(double value). Return -1, 0, or 1 according to the sign.",
     "int signum(double value) { return (value > 0) - (value < 0); }",
     "signum(-0.25) == -1 && signum(0) == 0 && signum(0.5) == 1"),
    ("Implement std::vector<int> interleave(const std::vector<int>& left, const std::vector<int>& right). Alternate left then right, appending the remaining items when either side runs out.",
     "#include <vector>\nstd::vector<int> interleave(const std::vector<int>& left, const std::vector<int>& right) {\n"
     "std::vector<int> output;\nfor (std::size_t i = 0; i < left.size() || i < right.size(); ++i) {\n"
     "if (i < left.size()) output.push_back(left[i]);\nif (i < right.size()) output.push_back(right[i]);\n}\nreturn output;\n}",
     "interleave({1, 3, 4}, {2}) == std::vector<int>({1, 2, 3, 4}) && interleave({}, {5}) == std::vector<int>({5})"),
    ("Implement unsigned binary_width(unsigned value), the number of bits needed to represent value without leading zeroes. Return zero for zero.",
     "unsigned binary_width(unsigned value) { unsigned width = 0; while (value) { ++width; value >>= 1; } return width; }",
     "binary_width(0) == 0 && binary_width(8) == 4 && binary_width(7) == 3"),
)


def holdout_rows():
    for i, (prefix, suffix, completion, check) in enumerate(FIM):
        suffix += "\n// End of this single-function example in the C++ completion benchmark.\n"
        yield {"id": f"fim-{i}", "role": "fim", "license": LICENSE, "prompt": prefix,
               "suffix": suffix, "expected": completion, "tests": f"int main() {{ return ({check}) ? 0 : 1; }}"}
    for i, (prompt, completion, check) in enumerate(CHAT):
        yield {"id": f"chat-{i}", "role": "chat", "license": LICENSE, "prompt": prompt,
               "expected": completion, "tests": f"int main() {{ return ({check}) ? 0 : 1; }}"}

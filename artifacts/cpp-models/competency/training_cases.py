"""Original C++20 supervision released under CC0-1.0."""

import re

# All samples include verification code. A standalone program is renamed and
# exercised in the same isolated container as a function sample.
CASES = (
    ("weighted_total", "Implement long long weighted_total(std::vector<int> counts). "
     "Sum each count multiplied by its one-based position.",
     """#include <vector>
long long weighted_total(std::vector<int> counts) {
    long long total = 0;
    long long position = 1;
    for (int count : counts) total += position++ * count;
    return total;
}""", "weighted_total({4, 2, -3}) == -1 && weighted_total({}) == 0"),
    ("first_duplicate", "Implement int first_duplicate(std::vector<int> ids). Return the first "
     "value seen for a second time, or -1 when every value is unique.",
     """#include <vector>
#include <unordered_set>
int first_duplicate(std::vector<int> ids) {
    std::unordered_set<int> seen;
    for (int id : ids)
        if (!seen.insert(id).second) return id;
    return -1;
}""", "first_duplicate({8, 9, 9, 8}) == 9 && first_duplicate({2, 4}) == -1"),
    ("decode_pairs", "Implement std::string decode_pairs(const std::string& encoded). Each pair is "
     "a digit 1 through 9 followed by an ASCII letter. Repeat each letter by its digit. "
     "Return an empty string for any malformed input.",
     """#include <string>
std::string decode_pairs(const std::string& encoded) {
    if (encoded.size() % 2) return {};
    std::string output;
    for (std::size_t pair = 0; pair < encoded.size(); pair += 2) {
        char digit = encoded[pair], letter = encoded[pair + 1];
        if (digit < '1' || digit > '9') return {};
        if (!(letter >= 'a' && letter <= 'z') && !(letter >= 'A' && letter <= 'Z'))
            return {};
        output.append(digit - '0', letter);
    }
    return output;
}""", 'decode_pairs("3k1Z") == "kkkZ" && decode_pairs("1a2") == "" && decode_pairs("3*") == ""'),
    ("longest_rise", "Implement int longest_rise(std::vector<int> history) giving the length "
     "of the longest strictly increasing contiguous run.",
     """#include <vector>
#include <algorithm>
int longest_rise(std::vector<int> history) {
    if (history.empty()) return 0;
    int run = 1, best = 1;
    for (std::size_t index = 1; index < history.size(); ++index) {
        run = history[index] > history[index - 1] ? run + 1 : 1;
        best = std::max(best, run);
    }
    return best;
}""", "longest_rise({7, 8, 8, 4, 5, 6}) == 3 && longest_rise({}) == 0"),
    ("brackets", "Implement bool balanced_brackets(std::string_view input). Check balanced and "
     "properly nested parentheses, square brackets and braces. Ignore all other characters.",
     """#include <string>
#include <string_view>
bool balanced_brackets(std::string_view input) {
    std::string stack;
    for (char c : input) {
        if (c == '(' || c == '[' || c == '{') stack += c;
        if (c == ')' || c == ']' || c == '}') {
            if (stack.empty()) return false;
            char open = stack.back();
            if ((c == ')' && open != '(') || (c == ']' && open != '[')
                || (c == '}' && open != '{')) return false;
            stack.pop_back();
        }
    }
    return stack.empty();
}""", 'balanced_brackets("x{[()]}") && !balanced_brackets("([)]") && !balanced_brackets("(")'),
    ("reachable", "Implement bool grid_reachable(Board board), where Board is a vector of strings. A rectangular board "
     "contains S, E, dots and # walls. Return whether S can reach E with four-direction movement.",
     """#include <queue>
#include <string>
#include <vector>
using Board = std::vector<
    std::basic_string<char>>;
bool grid_reachable(Board board) {
    const int height = static_cast<int>(board.size());
    if (!height) return false;
    const int width = static_cast<int>(board.front().size());
    struct Cell { int row; int col; };
    std::queue<Cell> pending;
    for (int r = 0; r < height; ++r)
        for (int c = 0; c < width; ++c)
            if (board[r][c] == 'S') {
                pending.push({r, c});
                board[r][c] = '#';
            }
    const int offsets[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    while (!pending.empty()) {
        auto [r, c] = pending.front();
        pending.pop();
        for (const auto& offset : offsets) {
            int nr = r + offset[0], nc = c + offset[1];
            if (nr < 0 || nc < 0 || nr >= height || nc >= width || board[nr][nc] == '#')
                continue;
            if (board[nr][nc] == 'E') return true;
            board[nr][nc] = '#';
            pending.push({nr, nc});
        }
    }
    return false;
}""", 'grid_reachable({"S#E", "..."}) && !grid_reachable({"S#E", ".#."})'),
    ("ledger", "Implement auto ledger(std::istream& in). Read name and signed "
     "quantity pairs until EOF. Sum quantities by name and omit names whose net total is zero.",
     """#include <map>
#include <istream>
#include <string>
auto ledger(std::istream& in) {
    using Key = std::string;
    std::map<Key, int> amounts;
    std::string name;
    int amount;
    while (in >> name >> amount) amounts[name] += amount;
    for (auto it = amounts.begin(); it != amounts.end();) {
        if (it->second == 0) it = amounts.erase(it);
        else ++it;
    }
    return amounts;
}""", '([] { std::istringstream in("pear 4 apple 2 pear -4 apple -7"); return ledger(in); })() == std::map<std::string,int>{{"apple", -5}}'),
    ("temperatures", "From a blank file, create a console program that reads signed temperatures from standard "
     "input until EOF. Print the minimum and maximum separated by one space and a newline. "
     "For empty input print EMPTY followed by a newline.",
     """#include <algorithm>
#include <iostream>
int main() {
    int degrees;
    if (!(std::cin >> degrees)) {
        std::cout << "EMPTY\\n";
        return 0;
    }
    int low = degrees, high = degrees;
    while (std::cin >> degrees) {
        low = std::min(low, degrees);
        high = std::max(high, degrees);
    }
    std::cout << low << ' ' << high << '\\n';
    return 0;
}""", 'run("2 -3 9 -1") == "-3 9\\n" && run("") == "EMPTY\\n"'),
    ("hops", "Create a console tool. It reads a positive integer n and prints the number "
     "of ordered ways to reach n using strides of length 1 or 3. Read one line, print one integer. "
     "Assume 1 <= n <= 40.",
     """#include <array>
#include <iostream>
int main() {
    int n;
    if (!(std::cin >> n) || n < 1 || n > 40) return 1;
    std::array<long long, 41> ways{};
    ways[0] = 1;
    for (int i = 1; i <= n; ++i) {
        ways[i] = ways[i - 1];
        if (i >= 3) ways[i] += ways[i - 3];
    }
    std::cout << ways[n] << '\\n';
    return 0;
}""", 'run("1") == "1\\n" && run("6") == "6\\n"'),
    ("counts", "Build a complete console tool. It reads whitespace-separated words, counts each "
     "word, and prints distinct words in lexicographical order followed by a colon and the count. "
     "Print one record per line. Preserve case.",
     """#include <map>
#include <iostream>
#include <string>
int main() {
    using Word = std::string;
    std::map<Word, int> counts;
    std::string word;
    while (std::cin >> word) ++counts[word];
    for (const auto& [key, count] : counts)
        std::cout << key << ':' << count << std::endl;
    return 0;
}""", 'run("one TWO one") == "TWO:1\\none:2\\n" && run("") == ""'),
)

FILL = (
    ("odd_sum", "Add the odd numbers to total and leave all other values out.",
     """#include <vector>
long long odd_sum(std::vector<int> values) {
    long long total{};""", "    return total;\n}",
     """for (int value : values) {
    if (value % 2 != 0) total += value;
}""", "odd_sum({-3, 5, 2, 8}) == 2 && odd_sum({2}) == 0"),
    ("ending", "Remove a final newline if there is one.",
     """#include <string>
std::string trim_line_end(std::string line) {""", "    return line;\n}",
     r"if (!line.empty() && line.back() == '\n') line.pop_back();",
     'trim_line_end("x\\n") == "x" && trim_line_end("x") == "x" && trim_line_end("").empty()'),
    ("squares", "Populate the result with the square of each value.",
     """#include <vector>
auto squares(std::vector<int> input) {
    auto result = std::vector<int>();
    result.reserve(input.size());""", "    return result;\n}",
     """for (int value : input) {
    result.push_back(value * value);
}""", "squares({-2, 0, 4}) == std::vector<int>({4, 0, 16})"),
    ("offset", "Reject a negative offset or one beyond the final element.",
     """#include <vector>
bool valid_offset(std::vector<int> data, int offset) {""", "    return true;\n}",
     "if (offset < 0 || static_cast<std::size_t>(offset) >= data.size()) return false;",
     "valid_offset({2}, 0) && !valid_offset({2}, 1) && !valid_offset({2}, -1)"),
)

def system_prompt(language, contextual, instruction):
    name = "C++20" if language == "cpp" else "Python"
    if contextual:
        mode = "Return only the code to insert at the cursor. Do not repeat surrounding code."
    elif re.search(r"^(?:implement|define|write)\s+[^\n.]+\([^\n]*\)", instruction, re.I):
        mode = ("Return the requested function definition with its required headers or imports and helpers. "
                "Leave out the entry point, example calls, and tests.")
    else:
        mode = "Return one complete standalone program with the required headers or imports and a runnable entry point."
    return f"Return only {name} source code. {mode} Stop immediately after the code."


def request(instruction, before="", after=""):
    prompt = f"Language: cpp\nRequest: {instruction}"
    if before or after:
        prompt += f"\nBefore cursor:\n{before}\nAfter cursor:\n{after}"
    return prompt


def program_harness(code, check):
    prelude = '#define main tessera_candidate_main\n'
    tests = """
#undef main
#include <iostream>
#include <sstream>
#include <string>
std::string run(const std::string& source) {
    std::istringstream input(source);
    std::ostringstream output;
    auto* original_input = std::cin.rdbuf(input.rdbuf());
    auto* original_output = std::cout.rdbuf(output.rdbuf());
    std::cin.clear();
    const int status = tessera_candidate_main();
    std::cin.rdbuf(original_input);
    std::cout.rdbuf(original_output);
    return status == 0 ? output.str() : "PROGRAM FAILED";
}
"""
    return prelude + code, tests + f"int main() {{ return ({check}) ? 0 : 1; }}"


def training_rows():
    for name, instruction, code, check in CASES:
        if "int main()" in code:
            complete, tests = program_harness(code, check)
        else:
            complete = code
            tests = f"#include <sstream>\nint main() {{ return ({check}) ? 0 : 1; }}"
        yield {"id": name, "license": "CC0-1.0", "prompt": request(instruction),
               "solution": code, "code": complete, "tests": tests, "contextual": False}
    for name, instruction, before, after, code, check in FILL:
        complete = before + "\n    " + code.replace("\n", "\n    ") + "\n" + after
        yield {"id": name, "license": "CC0-1.0", "prompt": request(instruction, before, after),
               "solution": code, "code": complete, "tests": f"int main() {{ return ({check}) ? 0 : 1; }}",
               "contextual": True}

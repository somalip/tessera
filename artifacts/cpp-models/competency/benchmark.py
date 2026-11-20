"""Paired Python and C++ holdout tasks, dedicated to CC0-1.0."""

from training_cases import program_harness, request

FUNCTIONS = (
    ("free_slots", "clip each half-open busy interval to [0, limit), "
     "ignore empty or reversed intervals, merge overlaps and touching intervals, "
     "and return the remaining maximal half-open free intervals in order. "
     "Return an empty result for limit <= 0.",
     "std::vector<std::pair<int,int>> free_slots(int limit, std::vector<std::pair<int,int>> busy)",
     "free_slots(limit, busy)",
     """#include <algorithm>
#include <utility>
#include <vector>
std::vector<std::pair<int,int>> free_slots(int limit, std::vector<std::pair<int,int>> busy) {
    std::vector<std::pair<int,int>> gaps;
    if (limit <= 0) return gaps;
    std::sort(busy.begin(), busy.end());
    int cursor = 0;
    for (auto [a,b] : busy) {
        a = std::max(0, a);
        b = std::min(limit, b);
        if (a >= b) continue;
        if (cursor < a) gaps.emplace_back(cursor, a);
        cursor = std::max(cursor, b);
    }
    if (cursor < limit) gaps.emplace_back(cursor, limit);
    return gaps;
}""",
     """def free_slots(limit, busy):
    if limit <= 0:
        return []
    gaps = []
    cursor = 0
    for a, b in sorted(busy):
        a, b = max(0, a), min(limit, b)
        if a >= b:
            continue
        if cursor < a:
            gaps.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < limit:
        gaps.append((cursor, limit))
    return gaps""",
     """using Pairs = std::vector<std::pair<int,int>>;
int main() {
    if (free_slots(13, {{4,8},{-5,2},{7,10},{12,41},{11,9},{2,4}}) != Pairs{{10,12}}) return 1;
    return free_slots(7, {{2,3},{4,5}}) == Pairs{{0,2},{3,4},{5,7}}
      && free_slots(0, {}).empty() && free_slots(8, {}) == Pairs{{0,8}} ? 0 : 1;
}""",
     """assert free_slots(13, [(4,8),(-5,2),(7,10),(12,41),(11,9),(2,4)]) == [(10,12)]
assert free_slots(7, [(2,3),(4,5)]) == [(0,2),(3,4),(5,7)]
assert not free_slots(0, [])
assert free_slots(8, []) == [(0,8)]"""),
    ("shortest_span", "return the length of the shortest nonempty contiguous span "
     "of positive integers whose sum is at least threshold, or zero if none exists. "
     "Use linear time. Assume threshold is positive.",
     "int shortest_span(const std::vector<int>& values, long long threshold)",
     "shortest_span(values, threshold)",
     """#include <algorithm>
#include <vector>
int shortest_span(const std::vector<int>& values, long long threshold) {
    std::size_t left = 0, best = values.size() + 1;
    long long sum = 0;
    for (std::size_t right = 0; right < values.size(); ++right) {
        sum += values[right];
        while (sum >= threshold) {
            best = std::min(best, right - left + 1);
            sum -= values[left++];
        }
    }
    return best <= values.size() ? static_cast<int>(best) : 0;
}""",
     """def shortest_span(values, threshold):
    left = total = 0
    best = len(values) + 1
    for right, value in enumerate(values):
        total += value
        while total >= threshold:
            best = min(best, right - left + 1)
            total -= values[left]
            left += 1
    return best if best <= len(values) else 0""",
     """int main() {
    return shortest_span({2,3,1,2,4,3}, 7) == 2 && shortest_span({6}, 7) == 0
      && shortest_span({}, 1) == 0 && shortest_span({2000000000,2000000000}, 3000000000LL) == 2 ? 0 : 1;
}""",
     """assert shortest_span([2,3,1,2,4,3], 7) == 2
assert shortest_span([6], 7) == shortest_span([], 1) == 0
assert shortest_span([2000000000,2000000000], 3000000000) == 2"""),
    ("build_layers", "take n tasks numbered 0 through n-1 and prerequisite pairs "
     "(a,b) meaning a must finish before b. Return all tasks available in each round "
     "as a sorted list, processing the round simultaneously. Duplicate pairs count once. "
     "Return an empty list when a cycle makes completion impossible. Indices are valid.",
     "std::vector<std::vector<int>> build_layers(int n, const std::vector<std::pair<int,int>>& prerequisites)",
     "build_layers(n, prerequisites)",
     """#include <algorithm>
#include <set>
#include <utility>
#include <vector>
std::vector<std::vector<int>> build_layers(int n, const std::vector<std::pair<int,int>>& prerequisites) {
    std::vector<std::set<int>> edges(n);
    std::vector<int> degree(n);
    for (auto [a,b] : prerequisites)
        if (edges[a].insert(b).second) ++degree[b];
    std::vector<int> current;
    for (int i=0; i<n; ++i) if (!degree[i]) current.push_back(i);
    std::vector<std::vector<int>> rounds;
    int finished = 0;
    while (!current.empty()) {
        std::sort(current.begin(), current.end());
        rounds.push_back(current);
        finished += static_cast<int>(current.size());
        std::vector<int> next;
        for (int i : current)
            for (int j : edges[i]) if (--degree[j] == 0) next.push_back(j);
        current = std::move(next);
    }
    if (finished != n) return {};
    return rounds;
}""",
     """def build_layers(n, prerequisites):
    edges = [set() for _ in range(n)]
    degree = [0] * n
    for a, b in set(prerequisites):
        edges[a].add(b)
        degree[b] += 1
    current = [i for i in range(n) if degree[i] == 0]
    rounds = []
    while current:
        rounds.append(sorted(current))
        following = []
        for i in current:
            for j in edges[i]:
                degree[j] -= 1
                if degree[j] == 0:
                    following.append(j)
        current = following
    return rounds if sum(map(len, rounds)) == n else []""",
     """int main() {
    using Rounds = std::vector<std::vector<int>>;
    return build_layers(6, {{0,2},{1,2},{1,2},{2,3},{0,4}}) == Rounds{{0,1,5},{2,4},{3}}
      && build_layers(3, {{0,1},{1,0}}).empty()
      && build_layers(3, {}) == Rounds{{0,1,2}} && build_layers(0, {}).empty() ? 0 : 1;
}""",
     """assert build_layers(6, [(0,2),(1,2),(1,2),(2,3),(0,4)]) == [[0,1,5],[2,4],[3]]
assert not build_layers(3, [(0,1),(1,0)])
assert build_layers(3, []) == [[0,1,2]]
assert not build_layers(0, [])"""),
    ("top_words", "return up to k distinct input words, most frequent first, with ties "
     "broken by ascending lexicographic order. Preserve case. Return an empty result for k <= 0.",
     "std::vector<std::string> top_words(const std::vector<std::string>& words, int k)",
     "top_words(words, k)",
     """#include <algorithm>
#include <map>
#include <string>
#include <vector>
std::vector<std::string> top_words(const std::vector<std::string>& words, int k) {
    if (k <= 0) return {};
    std::map<std::string,int> counts;
    for (const auto& word : words) ++counts[word];
    std::vector<std::string> result;
    for (const auto& item : counts) result.push_back(item.first);
    std::sort(result.begin(), result.end(), [&](const auto& a, const auto& b) {
        return counts.at(a) == counts.at(b) ? a < b : counts.at(a) > counts.at(b);
    });
    if (result.size() > static_cast<std::size_t>(k)) result.resize(k);
    return result;
}""",
     """from collections import Counter
def top_words(words, k):
    counts = Counter(words)
    return sorted(counts, key=lambda word: (-counts[word], word))[:max(0, k)]""",
     """int main() {
    using Words = std::vector<std::string>;
    return top_words({"z","a","z","a","A","B"},3) == Words{"a","z","A"}
      && top_words({"z","z","t"},9) == Words{"z","t"}
      && top_words({"a"},-1).empty() && top_words({},2).empty() ? 0 : 1;
}""",
     """assert top_words(["z","a","z","a","A","B"],3) == ["a","z","A"]
assert top_words(["z","z","t"],9) == ["z","t"]
assert not top_words(["a"],-1)
assert not top_words([],2)"""),
)

PROJECT = (
    "stock_cli",
    "Write a standalone program reading commands from standard input until EOF. "
    "PUT name adds one unit, TAKE name removes one if available, and QUERY name "
    "prints the current quantity as an integer followed by a newline. Names have "
    "no whitespace and are case sensitive. Only QUERY prints anything.",
    """#include <iostream>
#include <string>
#include <unordered_map>
int main() {
    std::unordered_map<std::string,int> stock;
    std::string command, name;
    while (std::cin >> command >> name) {
        auto& count = stock[name];
        if (command == "PUT") ++count;
        else if (command == "TAKE" && count > 0) --count;
        else if (command == "QUERY") std::cout << count << '\\n';
    }
    return 0;
}""",
    """import sys
def main():
    stock = {}
    for line in sys.stdin:
        command, name = line.split()
        count = stock.get(name, 0)
        if command == "PUT":
            stock[name] = count + 1
        elif command == "TAKE" and count > 0:
            stock[name] = count - 1
        elif command == "QUERY":
            print(count)
if __name__ == "__main__":
    main()""",
    "TAKE bolt\nQUERY bolt\nPUT bolt\nPUT bolt\nPUT Bolt\nQUERY bolt\nTAKE bolt\nQUERY bolt\nQUERY Bolt\n",
    "0\n2\n1\n1\n",
)

SNIPPET = (
    "finite_sum",
    "Add only the finite numbers in samples to total.",
    "#include <cmath>\n#include <vector>\ndouble finite_sum(const std::vector<double>& samples) {\n    double total = 0;",
    "    return total;\n}",
    "for (double value : samples) {\n    if (std::isfinite(value)) total += value;\n}",
    "import math\ndef finite_sum(samples):\n    total = 0",
    "    return total",
    "for value in samples:\n    if math.isfinite(value):\n        total += value",
    """#include <limits>
int main() {
    return finite_sum({1.5, -2, std::numeric_limits<double>::infinity(),
          std::numeric_limits<double>::quiet_NaN(), 4}) == 3.5 && finite_sum({}) == 0 ? 0 : 1;
}""",
    """assert finite_sum([1.5, -2, float('inf'), float('nan'), 4]) == 3.5
assert finite_sum([]) == 0""",
)


def rows():
    for name, task, cpp_sig, py_sig, cpp, py, cpp_test, py_test in FUNCTIONS:
        for lang, signature, code, tests in (
            ("cpp", cpp_sig, cpp, cpp_test), ("python", py_sig, py, py_test),
        ):
            yield case(name, lang, f"Implement {signature}. {task.capitalize()}", code, tests)
    name, task, cpp, py, input_text, expected = PROJECT
    import json
    check = f"run({json.dumps(input_text)}) == {json.dumps(expected)} && run(\"\") == \"\""
    wrapped, tests = program_harness(cpp, check)
    yield {**case(name, "cpp", task, cpp, tests), "code": wrapped, "project_check": check}
    tests = f"""
import io, runpy, sys
from contextlib import redirect_stdout
def run(source):
    old = sys.stdin
    try:
        sys.stdin = io.StringIO(source)
        result = io.StringIO()
        with redirect_stdout(result):
            exec(candidate, {{'__name__': '__main__'}})
        return result.getvalue()
    finally:
        sys.stdin = old
assert run({input_text!r}) == {expected!r}
assert run('') == ''
"""
    yield {**case(name, "python", task, py, tests), "code": "candidate = " + repr(py), "project_check": True}
    name, task, cb, ca, cc, pb, pa, pc, ct, pt = SNIPPET
    for lang, before, after, code, tests in (("cpp", cb, ca, cc, ct), ("python", pb, pa, pc, pt)):
        yield {**case(name, lang, task, code, tests, before, after), "code": insert(before, after, code)}


def insert(before, after, code):
    return before + "\n" + "\n".join("    " + line for line in code.splitlines()) + "\n" + after


def case(name, lang, task, code, tests, before="", after=""):
    prompt = request(task, before, after).replace("Language: cpp\n", f"Language: {lang}\n", 1)
    return {"id": name, "language": lang, "license": "CC0-1.0", "prompt": prompt,
            "expected": code, "tests": tests, "before": before, "after": after}

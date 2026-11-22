"""Original C++20 practice examples offered under CC0-1.0."""

from collections.abc import Iterator

# Independent exercises for boundary handling, traversal, ranking, and parsing.
PRACTICE = (
    (
        "practice_covered_length",
        "Implement int covered_length(std::vector<std::array<int, 2>> spans). "
        "Return the number of integers covered by the half-open intervals. "
        "Discard empty or reversed intervals. Endpoints are between -10000 and 10000.",
        """#include <algorithm>
#include <array>
#include <vector>
int covered_length(std::vector<std::array<int, 2>> spans) {
    std::sort(spans.begin(), spans.end());
    int total = 0, right = -10000;
    for (const auto& [lo, hi] : spans) {
        if (lo >= hi || hi <= right) continue;
        total += hi - std::max(right, lo);
        right = hi;
    }
    return total;
}""",
        "covered_length({{2,8},{-3,2},{4,6},{10,11},{20,19}}) == 12"
        " && covered_length({}) == 0",
    ),
    (
        "practice_distances",
        "Write a function named distances(edges, source) returning a vector of integers. "
        "The adjacency list is a vector of integer vectors describing a directed graph. Give the shortest unweighted "
        "distance from source to each vertex, using -1 for unreachable vertices.",
        """#include <queue>
#include <vector>
using std::vector;
vector<int> distances(vector<vector<int>> edges, int source) {
    std::vector<int> result(edges.size(), -1);
    std::queue<int> pending;
    pending.push(source);
    result[source] = 0;
    while (!pending.empty()) {
        const int vertex = pending.front();
        pending.pop();
        for (int next : edges[vertex]) {
            if (result[next] >= 0) continue;
            result[next] = result[vertex] + 1;
            pending.push(next);
        }
    }
    return result;
}""",
        "distances({{2,1},{2},{0},{}},0) == std::vector<int>({0,1,1,-1})"
        " && distances({{}},0) == std::vector<int>({0})",
    ),
    (
        "practice_rank_scores",
        "Write a function named rank_scores(scores, limit) returning a vector of integer indices. "
        "Accept a vector of integer scores and an unsigned limit. Rank scores descending, breaking ties by original "
        "index. If limit exceeds the list size return every index.",
        """#include <algorithm>
#include <numeric>
#include <vector>
using std::vector;
vector<int> rank_scores(vector<int> scores, unsigned limit) {
    std::vector<int> order(scores.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&](int left, int right) {
        return scores[left] > scores[right];
    });
    order.resize(std::min<std::size_t>(limit, order.size()));
    return order;
}""",
        "rank_scores({4,9,1,9,2},3) == std::vector<int>({1,3,0})"
        " && rank_scores({-5,-2},7) == std::vector<int>({1,0}) && rank_scores({3},0).empty()",
    ),
    (
        "practice_temperature_cli",
        "Build a standalone console program. Read one integer Celsius temperature per line "
        "and print FREEZE for values below zero or OK otherwise. Print INVALID for "
        "lines that contain missing values, extra fields, or nonintegers.",
        """#include <sstream>
#include <ios>
#include <string>
#include <iostream>
int main() {
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream record(line);
        int temperature;
        std::string extra;
        if (!(record >> temperature) || (record >> extra))
            std::cout << "INVALID\\n";
        else
            std::cout << (temperature < 0 ? "FREEZE\\n" : "OK\\n");
    }
    return 0;
}""",
        r'run("-4\n0\n9 x\n3.2\n\n 10 \n") == "FREEZE\nOK\nINVALID\nINVALID\nINVALID\nOK\n"'
        ' && run("") == ""',
    ),
)


def examples() -> Iterator[tuple[str, str, str, str]]:
    yield from PRACTICE

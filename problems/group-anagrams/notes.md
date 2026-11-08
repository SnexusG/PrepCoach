# Group Anagrams — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/group-anagrams/


## 2026-11-08 — solved (13/13), outcome 0.92
- Approach: 26-int count array per word, `Arrays.toString(count)` as HashMap key, group values; return `new ArrayList<>(map.values())`.
- Complexity: O(n·k) time, O(n) extra space (values are references to input strings).
- Mistakes: complexity needed prompting — said O(n²) before settling on n·k; claimed HashMap insert is O(log n) (it's O(1) average); unsure of space.
- Idiom: `map.computeIfAbsent(key, k -> new ArrayList<>()).add(s)` replaces putIfAbsent + get.
- Follow-up (Unicode): a bigger fixed array doesn't scale (~1.1M code points) — use a sorted-chars key (O(n·k log k)) or a HashMap<Integer,Integer> of code-point counts.

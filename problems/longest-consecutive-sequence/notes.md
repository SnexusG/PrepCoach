# Longest Consecutive Sequence — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/longest-consecutive-sequence/


## 2026-11-28 — outcome 0.80, 14/14, 0 hints
- Final: put all numbers in a set; for each x with x-1 absent (a run start), count up while x+1, x+2… exist. O(n) time (each element walked by an inner loop at most once), O(n) space.
- First idea: map of run lengths with forward propagation on insert — O(n^2) on descending input (1+2+…+n). Second idea (two passes, look only at x-1) breaks on 3,1,5,2,4: array order ≠ value order.
- TreeMap would keep order but costs log n per insert → O(n log n).
- Slips: complexity not stated unprompted; HashMap.keys() doesn't exist (keySet()); use HashSet instead of a map with dummy values; while(set.contains(x)) beats while(true)+break.
- Key insight: "x-1 not in the set" marks a run start, so each run is walked once.
- Streaming follow-up: store run length at both boundaries; on new x, len = left(x-1) + right(x+1) + 1, update x-left and x+right.

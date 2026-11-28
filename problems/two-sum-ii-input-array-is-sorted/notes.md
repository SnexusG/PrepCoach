# Two Sum II Input Array Is Sorted — notes

Topic: Two Pointers · Difficulty: medium · https://leetcode.com/problems/two-sum-ii-input-array-is-sorted/


## 2026-11-28 — solved, outcome 0.82 (14/14, 1 nudge)
- Approach: two pointers from both ends; sum too big → right--, too small → left++. O(n) time, O(1) space.
- First plan: binary search for the complement per element, O(n log n) / O(1), complexity stated unprompted.
- Key insight: as left grows the needed complement shrinks, so the right boundary only moves left; both pointers move at most n steps in total.
- Mistakes: `numbers.size()` on an int[] (use `.length`); no break/return after the match → infinite loop. Compile and trace before submitting.
- Follow-up (unsorted): HashMap value → index, O(n) time / O(n) space, O(1) lookups. Watch duplicates like [5,5]: check the complement before inserting the current value.

# Top K Frequent Elements — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/top-k-frequent-elements/


## 2026-11-10 — solved (13/13), outcome 0.79
- Approach: HashMap value→count, then HashMap count→list of values, walk counts from high to low collecting k values. O(n) time, O(n) space.
- Mistake: first plan was a TreeSet ordered by count — equal counts compare as equal, so the set silently drops elements (counterexample [1,1,2,2,3], k=2).
- Java syntax rust: `HashMap<int,…>` → `Integer`; `containsKey` not `contains`; `add` not `append`; `nums.length`; can't `+=` on `get()`.
- Cleanups: start the bucket walk at `nums.length` (not hard-coded 1e5); `merge(x, 1, Integer::sum)`; an array of lists indexed by count is simpler than a second map.
- Follow-up (huge n, tiny k): min-heap capped at k over the counts → O(m log k) time, O(k) extra beyond the count map.

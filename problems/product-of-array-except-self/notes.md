# Product of Array Except Self — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/product-of-array-except-self/


## 2026-11-10 — solved (14/14), level-1 hint
- First plan: left-product and right-product arrays, answer[i] = left[i-1] * right[i+1] (boundaries = 1). O(n) time, O(n) extra.
- After nudge ("the output array can hold one of them"): suffix products in the output array, then a left-to-right pass with a running prefix product → O(1) extra space.
- Code compiled first try. Cleanup: store the *exclusive* suffix (output[n-1] = 1) to remove both if/else branches.
- Complexity still given only when asked — state time + space with the approach.
- Follow-up (division allowed): ≥2 zeros → all 0; exactly one zero → only the zero's index gets the product of the rest; no zeros → total / nums[i].

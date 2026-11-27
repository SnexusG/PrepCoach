# Encode and Decode Strings — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/encode-and-decode-strings/


## 2026-11-27 — solved (14/14), no hints
- Approach: 3-digit element count, then a 3-digit length per string, then all strings concatenated. Decode reads the fixed-width headers, then slices with a running offset. O(total chars) time and space.
- Handled the empty list vs [""] case correctly in the design (count 000 vs 001 + length 000).
- Bugs: `Sting` typo, `List.append` → `add`, `;;` after return (unreachable statement); decode first used the previous string's length instead of the cumulative offset.
- Cleanup: `String.format("%03d", n)` replaces both padding if-chains; plain `int` not `Integer`; rename `prevElementLen` → `offset`.
- Follow-up (unbounded lengths): variable-width length + separator, e.g. `4#neet4#code` — decode reads digits to the first `#`, then jumps exactly len chars, so `#` inside strings is harmless.

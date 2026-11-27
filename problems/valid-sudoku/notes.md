# Valid Sudoku — notes

Topic: Arrays & Hashing · Difficulty: medium · https://leetcode.com/problems/valid-sudoku/


## 2026-11-11 — solved (15/15), level-1 nudge (bug pointer)
- Approach: per-row and per-column maps; at each box's bottom-right corner ((row+1)%3==0 && (col+1)%3==0) scan its 9 cells, duplicate if distinct count < filled count. O(81) = O(1).
- Misread: first planned to check every 3×3 window ending at (i,j) — counterexample 5 at (1,1) and (3,3) is valid but flagged.
- Bugs: generics with primitives, `new List<>()`, `list[i]` instead of `get(i)`; copy-paste in the nine box blocks stored the wrong cell → false duplicates.
- Cleanup: `Set<Character>` instead of `Map<Character,Boolean>`; loops over the box instead of 9 copied blocks.
- Follow-up: single pass with nine box sets, `boxIdx = 3*(row/3) + col/3`.

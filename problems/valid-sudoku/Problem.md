# Valid Sudoku
**Topic:** Arrays & Hashing · **Difficulty:** medium · **Original:** https://leetcode.com/problems/valid-sudoku/

You are given a 9×9 Sudoku board that may be only partly filled. Decide whether the digits placed so far
break any Sudoku rule:

1. No digit `1`–`9` appears more than once in any row.
2. No digit appears more than once in any column.
3. No digit appears more than once in any of the nine 3×3 boxes the grid is divided into.

Empty cells are `'.'`. Only the filled cells matter — you do **not** have to decide whether the puzzle can
actually be completed.

## Constraints
- `board.length == 9`, `board[i].length == 9`
- `board[i][j]` is a digit `'1'`–`'9'` or `'.'`

## Examples
```
Input:
[["5","3",".",".","7",".",".",".","."],
 ["6",".",".","1","9","5",".",".","."],
 [".","9","8",".",".",".",".","6","."],
 ["8",".",".",".","6",".",".",".","3"],
 ["4",".",".","8",".","3",".",".","1"],
 ["7",".",".",".","2",".",".",".","6"],
 [".","6",".",".",".",".","2","8","."],
 [".",".",".","4","1","9",".",".","5"],
 [".",".",".",".","8",".",".","7","9"]]
Output: true
```
```
Same board, but the top-left cell is "8" instead of "5".
Output: false   (column 0 now has two 8s, and so does the top-left box)
```

## Signature
```java
class Solution {
    public boolean isValidSudoku(char[][] board)
}
```

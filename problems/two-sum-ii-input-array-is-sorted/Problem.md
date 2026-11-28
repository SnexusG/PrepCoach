# Two Sum II - Input Array Is Sorted
**Topic:** Two Pointers · **Difficulty:** medium · **Original:** https://leetcode.com/problems/two-sum-ii-input-array-is-sorted/

You are given a **1-indexed** array of integers `numbers`, sorted in non-decreasing order, and an integer `target`.
Find the two numbers at positions `index1 < index2` whose sum equals `target`, and return `[index1, index2]`
(both 1-based).

Each input has **exactly one** valid answer, and you may not use the same element twice.
Your solution must use only **constant extra space**.

## Constraints
- `2 <= numbers.length <= 3 * 10^4`
- `-1000 <= numbers[i] <= 1000`
- `numbers` is sorted in non-decreasing order
- `-1000 <= target <= 1000`
- Exactly one solution exists.

## Examples
```
Input:  numbers = [1,3,4,8,12], target = 12
Output: [3,4]        (4 + 8 = 12)
```
```
Input:  numbers = [-3,0,5], target = 2
Output: [1,3]        (-3 + 5 = 2)
```
```
Input:  numbers = [5,5], target = 10
Output: [1,2]
```

## Signature
```java
class Solution {
    public int[] twoSum(int[] numbers, int target)
}
```

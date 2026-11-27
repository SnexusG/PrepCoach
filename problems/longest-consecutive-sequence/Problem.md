# Longest Consecutive Sequence
**Topic:** Arrays & Hashing · **Difficulty:** medium · **Original:** https://leetcode.com/problems/longest-consecutive-sequence/

You are given an **unsorted** integer array `nums`. Return the length of the longest run of consecutive
integers (`x, x+1, x+2, …`) that can be formed from values present in `nums`. The values don't need to be
adjacent in the array, and duplicates count once.

Your algorithm must run in **O(n)** time.

## Constraints
- `0 <= nums.length <= 10^5`
- `-10^9 <= nums[i] <= 10^9`

## Examples
```
Input:  nums = [50, 3, 1, 52, 2, 51, 4]
Output: 4          (1, 2, 3, 4)
```
```
Input:  nums = [7, 7, 8, 6, 6]
Output: 3          (6, 7, 8 — duplicates count once)
```
```
Input:  nums = []
Output: 0
```

## Signature
```java
class Solution {
    public int longestConsecutive(int[] nums)
}
```

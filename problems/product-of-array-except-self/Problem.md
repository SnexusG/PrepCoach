# Product of Array Except Self
**Topic:** Arrays & Hashing · **Difficulty:** medium · **Original:** https://leetcode.com/problems/product-of-array-except-self/

Given an integer array `nums`, build an array `answer` where `answer[i]` is the product of every element of
`nums` except `nums[i]`.

Your algorithm must run in O(n) time and **must not use the division operator**.

Every prefix product and suffix product of `nums` is guaranteed to fit in a 32-bit signed integer.

## Constraints
- `2 <= nums.length <= 10^5`
- `-30 <= nums[i] <= 30`
- Every prefix/suffix product fits in a 32-bit `int`.

## Examples
```
Input:  nums = [2,3,4,5]
Output: [60,40,30,24]
```
```
Input:  nums = [-2,0,3,1]
Output: [0,-6,0,0]
```
```
Input:  nums = [7,-1]
Output: [-1,7]
```

## Follow-up
Can you do it with O(1) extra space? (The output array does not count as extra space.)

## Signature
```java
class Solution {
    public int[] productExceptSelf(int[] nums)
}
```

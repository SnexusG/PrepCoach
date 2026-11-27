# Top K Frequent Elements
**Topic:** Arrays & Hashing · **Difficulty:** medium · **Original:** https://leetcode.com/problems/top-k-frequent-elements/

You are given an integer array `nums` and an integer `k`. Return the `k` values that appear most often in `nums`.
The values may be returned in any order.

It is guaranteed that the answer is unique: the set of the `k` most frequent values is well defined
(there is no tie at the boundary between the k-th and (k+1)-th most frequent value).

## Constraints
- `1 <= nums.length <= 10^5`
- `-10^4 <= nums[i] <= 10^4`
- `1 <= k <=` number of distinct values in `nums`
- The answer is unique.

## Examples
```
Input:  nums = [4,4,4,7,7,2], k = 2
Output: [4,7]
```
```
Input:  nums = [9], k = 1
Output: [9]
```
```
Input:  nums = [5,-1,5,-1,3,-1], k = 1
Output: [-1]
```

## Signature
```java
class Solution {
    public int[] topKFrequent(int[] nums, int k)
}
```

# Reverse Linked List

**Topic:** Linked List · **Difficulty:** Easy · **Original:** https://leetcode.com/problems/reverse-linked-list/

Given the first node of a singly linked list, reverse the direction of every link and return the node
that is now first (the old tail). An empty list stays empty.

Lists are shown as arrays of node values, front to back.

## Constraints
- 0 ≤ number of nodes ≤ 5000
- −5000 ≤ node value ≤ 5000

## Examples
```
Input:  [1,2,3,4,5]
Output: [5,4,3,2,1]
```
```
Input:  [1,2]
Output: [2,1]
```
```
Input:  []
Output: []
```

**Follow-up:** can you do it both iteratively and recursively? What does each cost in extra space?

## Method
```java
public ListNode reverseList(ListNode head)
```
`ListNode` has `int val` and `ListNode next` (provided by the harness).

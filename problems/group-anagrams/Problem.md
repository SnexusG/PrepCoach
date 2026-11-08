# Group Anagrams

**Topic:** Arrays & Hashing · **Difficulty:** Medium · **Original:** https://leetcode.com/problems/group-anagrams/

You get a list of lowercase words. Two words are *anagrams* when one can be turned into the other by
rearranging its letters (same letters, same counts). Partition the list into groups so that every
group holds exactly the words that are anagrams of one another, and return the groups.

The groups may come back in any order, and the words inside a group may be in any order. Every input
word (including repeats) must appear exactly once in the output.

## Constraints
- 1 ≤ number of words ≤ 10⁴
- 0 ≤ length of each word ≤ 100
- Words contain only `a`–`z`

## Examples
```
Input:  ["eat","tea","tan","ate","nat","bat"]
Output: [["bat"],["nat","tan"],["ate","eat","tea"]]
```
```
Input:  [""]
Output: [[""]]
```
```
Input:  ["abc","abc","bca"]
Output: [["abc","abc","bca"]]     // duplicates are kept
```

## Method
```java
public List<List<String>> groupAnagrams(String[] strs)
```

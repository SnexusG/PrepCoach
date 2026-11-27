# Encode and Decode Strings
**Topic:** Arrays & Hashing · **Difficulty:** medium · **Original:** https://leetcode.com/problems/encode-and-decode-strings/

Design a way to turn a list of strings into a **single string** (`encode`) and turn that single string back into
the **exact original list** (`decode`). The encoded string may be stored or sent over a network, so `decode`
gets nothing but that one string.

`decode(encode(strs))` must return a list equal to `strs` — same strings, same order, same count.
You may not rely on any serialization library (no `eval`-style tricks, no Java serialization).

## Constraints
- `0 <= strs.length <= 200`
- `0 <= strs[i].length <= 200`
- `strs[i]` may contain **any** of the 256 extended-ASCII characters — including digits, `#`, `,`, spaces and
  newlines.

## Examples
```
Input:  ["neet","code","love","you"]
decode(encode(input)) → ["neet","code","love","you"]
```
```
Input:  ["we","say",":","yes","!@#$%^&*()"]
decode(encode(input)) → ["we","say",":","yes","!@#$%^&*()"]
```
```
Input:  [""]          (one empty string — must not come back as an empty list)
decode(encode(input)) → [""]
```

## Testing
Each test calls `encode(strs)` and then `decode` on the result, and checks that the original list comes back.

## Signature
```java
class Solution {
    public String encode(List<String> strs)
    public List<String> decode(String s)
}
```

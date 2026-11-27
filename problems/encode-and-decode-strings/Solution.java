import java.util.*;

class Solution {
    public String encode(List<String> strs) {
        Integer n = strs.size();

        StringBuilder sb = new StringBuilder();

        // stores number of elements in the original list
        if(n >= 100){
            sb.append(""+n);
        }else if(n >= 10){
            sb.append("0"+n);
        }else{
            sb.append("00"+n);
        } 

        // stores size of elements
        Integer size = 0;
        for(String s : strs){
            size = s.length();
            if(size >= 100){
                sb.append(""+size);
            }else if(size >= 10){
                sb.append("0"+size);
            }else{
                sb.append("00"+size);
            } 
        }

        // finally stores the strings
        for(String s : strs){
            sb.append(s);
        }

        return sb.toString();
    }

    public List<String> decode(String s) {
        // get the number of elements e.g. 004 004 004 004 003 neetcodeloveyou
        int elements = Integer.parseInt(s.substring(0,3));
        
        List<String> strs = new ArrayList<>();

        int i = 3;
        int prevElementLen = 0;
        while(i <= elements*3){
            int elementLen = Integer.parseInt(s.substring(i, i+3));
            strs.add(s.substring((3+elements*3) + prevElementLen, ((3+elements*3) + prevElementLen) + elementLen));
            prevElementLen += elementLen;
            i+=3;
        }

        return strs;
    }
}

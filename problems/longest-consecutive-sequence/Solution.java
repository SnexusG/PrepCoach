import java.util.*;

class Solution {
    public int longestConsecutive(int[] nums) {
        HashMap<Integer, Integer> occ = new HashMap<>();
        int ans = 0;

        for(int i : nums){
            occ.put(i, 1);
        }

        for(Integer element : occ.keySet()){

            if(!occ.containsKey(element-1)){
                int localAns = 1;
                Integer checkElement = element+1;
                while(occ.containsKey(checkElement)){
                    localAns+=1;
                    checkElement+=1;
                }
                ans = Math.max(ans, localAns);
            }

        }

        return ans;
    }
}

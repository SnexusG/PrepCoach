import java.util.*;

class Solution {
    public int[] topKFrequent(int[] nums, int k) {
        HashMap<Integer, Integer> occHashMap = new HashMap<>();
        for(int i = 0; i < nums.length; ++i){
            if(!occHashMap.containsKey(nums[i])){
                occHashMap.put(nums[i], 1);
            }else{
                occHashMap.put(nums[i], occHashMap.get(nums[i])+1);
            }
        }

        HashMap<Integer, List<Integer>> groupByOcc = new HashMap<>();
        for(int i : occHashMap.keySet()){
            if(!groupByOcc.containsKey(occHashMap.get(i))){
                List<Integer> l = new ArrayList<>();
                l.add(i);
                groupByOcc.put(occHashMap.get(i), l);
            }else{
                groupByOcc.get(occHashMap.get(i)).add(i);
            }
        }

        int[] topK = new int[k];
        int count = 0; 
        for(int i = (int) 1e5; i > 0; --i){
            if(groupByOcc.containsKey(i)){
                for(int element : groupByOcc.get(i)){
                    topK[count] = element;
                    count+=1;
                    if(count == k){
                        break;
                    }
                }
                if(count == k){
                    break;
                }
            }
        }
        return topK;
    }
}

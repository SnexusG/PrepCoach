import java.util.*;

class Solution {
    public int[] productExceptSelf(int[] nums) {
        int n = nums.length;
        int[] outputArray = new int[n];
        for(int i = n-1; i >= 0; --i){
            if(i == n-1)
                outputArray[i] = nums[i];
            else
                outputArray[i] = nums[i]*outputArray[i+1];
        }
        int prefixProduct = 1;
        for(int i = 0; i < n; ++i){
            if(i < n-1)
                outputArray[i] = outputArray[i+1]*prefixProduct;
            else
                outputArray[i] = prefixProduct;
            prefixProduct = prefixProduct*nums[i];
        }
        return outputArray;
    }
}

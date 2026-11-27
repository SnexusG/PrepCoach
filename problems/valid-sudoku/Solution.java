import java.util.*;

class Solution {
    public boolean isValidSudoku(char[][] board) {
        // TODO
        List<HashMap<Character, Boolean>> rowMap = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            rowMap.add(new HashMap<>());
        }   
        List<HashMap<Character, Boolean>> colMap = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            colMap.add(new HashMap<>());
        }

        for(int row = 0; row < 9; ++row){
            for(int col = 0; col < 9; ++col){
                // check row
                if(rowMap.get(row).containsKey(board[row][col]))
                    return false;
                // check col
                if(colMap.get(col).containsKey(board[row][col]))
                    return false;
                
                if(board[row][col] != '.'){
                    rowMap.get(row).put(board[row][col], true);
                    colMap.get(col).put(board[row][col], true);
                }
                
                if((row+1)%3 == 0 && (col+1)%3 == 0){
                    // check 3*3 grid
                    Map<Character, Boolean> boxMap = new HashMap<>();
                    int valElements = 0;
                    if(board[row][col] != '.'){
                        boxMap.put(board[row][col], true);
                        valElements+=1;
                    }
                    if(board[row-1][col] != '.'){
                        boxMap.put(board[row-1][col], true);
                        valElements+=1;
                    }
                    if(board[row-2][col] != '.'){
                        boxMap.put(board[row-2][col], true);
                        valElements+=1;
                    }
                    if(board[row][col-1] != '.'){
                        boxMap.put(board[row][col-1], true);
                        valElements+=1;
                    }
                    if(board[row][col-2] != '.'){
                        boxMap.put(board[row][col-2], true);
                        valElements+=1;
                    }
                    if(board[row-1][col-1] != '.'){
                        boxMap.put(board[row-1][col-1], true);
                        valElements+=1;
                    }
                    if(board[row-2][col-2] != '.'){
                        boxMap.put(board[row-2][col-2], true);
                        valElements+=1;
                    }
                    if(board[row-1][col-2] != '.'){
                        boxMap.put(board[row-1][col-2], true);
                        valElements+=1;
                    }
                    if(board[row-2][col-1] != '.'){
                        boxMap.put(board[row-2][col-1], true);
                        valElements+=1;
                    }
                    if(boxMap.size() < valElements)
                        return false;
                }
            }
        }
        return true;
    }
}

#include <stdio.h>

// 大きいほうを返す関数（関数を呼ばないので「リーフ」）
int max(int a, int b) {
    if (a > b) {
        return a;
    } else {
        return b;
    }
}

int main(void) {
    printf("%d\n", max(7, 12));
    printf("%d\n", max(-3, -8));
    return 0;
}

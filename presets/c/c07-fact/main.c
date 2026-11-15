#include <stdio.h>

// 自分自身を呼ぶ関数（再帰）。呼ぶたびに n と $ra をスタックに積む
int fact(int n) {
    if (n < 1) {
        return 1;
    } else {
        return n * fact(n - 1);
    }
}

int main(void) {
    printf("5! = %d\n", fact(5));
    return 0;
}

#include <stdio.h>

// add の中身は別のファイル（mathfuncs.c）にある。ここでは宣言だけ
int add(int a, int b);

int main(void) {
    int x;
    x = add(5, 10);
    printf("%d\n", x);
    return 0;
}

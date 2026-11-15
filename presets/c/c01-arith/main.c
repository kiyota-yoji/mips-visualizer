#include <stdio.h>

// 第05回の例：f = (g + h) - (i + j)
int main(void) {
    int g = 5, h = 3, i = 4, j = 2;
    int f;
    f = (g + h) - (i + j);
    printf("f = %d\n", f);
    return 0;
}

#include <stdio.h>

// 文字は数（文字コード）。'A' は 65
int main(void) {
    for (int c = 'A'; c <= 'Z'; c++) {
        putchar(c);
    }
    putchar('\n');
    printf("'A' = %d\n", 'A');
    return 0;
}

#include <stdio.h>

// for と while：1 から 10 までの合計
int main(void) {
    int sum = 0;
    for (int i = 1; i <= 10; i++) {
        sum = sum + i;
    }
    printf("for: %d\n", sum);

    int k = 10;
    sum = 0;
    while (k > 0) {
        sum += k;
        k--;
    }
    printf("while: %d\n", sum);
    return 0;
}

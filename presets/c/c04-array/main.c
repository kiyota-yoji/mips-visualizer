#include <stdio.h>

// 配列はメモリの .data に並ぶ（1要素 4 バイト）
int A[5] = {3, 1, 4, 1, 5};

int main(void) {
    int sum = 0;
    for (int k = 0; k < 5; k++) {
        sum += A[k];
    }
    A[0] = sum;
    printf("合計 = %d\n", A[0]);
    return 0;
}

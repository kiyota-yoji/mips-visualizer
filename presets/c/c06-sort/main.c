#include <stdio.h>

// sort の中身は sort.c にある
void sort(int v[], int n);

int v[8] = {5, 2, 9, 1, 7, 3, 8, 4};

int main(void) {
    sort(v, 8);
    for (int k = 0; k < 8; k++) {
        printf("%d ", v[k]);
    }
    printf("\n");
    return 0;
}

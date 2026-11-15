#include <stdio.h>
int g = 7;
int cnt;
int B[4];
int sq(int x) { return x * x; }
int add3(int a, int b, int c) { return a + b + c; }
int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}
int main(void) {
    int loc[6] = {9, 8, 7};
    int i;
    for (i = 0; i < 6; i++) {
        if (i == 4) continue;
        if (i > 4 && loc[i] == 0) break;
        loc[i] += i * 2;
    }
    printf("%d %d %d %d %d\n", loc[0], loc[1], loc[2], loc[3], loc[4]);
    g++;
    ++g;
    cnt += 3;
    cnt = cnt * g - 1;
    printf("g=%d cnt=%d\n", g, cnt);
    B[2] = 5;
    B[2]++;
    B[1] = B[2] * 2;
    printf("%d %d %d\n", B[0], B[1], B[2]);
    printf("%d\n", add3(sq(2), sq(3), add3(1, sq(4), 5)));
    printf("%d %d\n", fib(10), sq(fib(6)));
    int a = -17, b = 5;
    printf("%d %d %d %d\n", a / b, a % b, -a / b, a * b);
    printf("%d %d %d %d %d %d\n", a < b, a > b, a <= -17, b >= 6, a == -17, a != b);
    printf("%d %d %d %d\n", a < 0 && b > 0, a > 0 || b > 10, !a, !(a < b));
    printf("%d %d %d %d %d\n", 6 & 3, 6 | 3, 6 ^ 3, ~6, 1 << 4);
    printf("%d %d\n", -32 >> 2, b << a + 19);
    int x = 3;
    int y = x++ + 10;
    int z = --x * 2;
    printf("%d %d %d\n", x, y, z);
    while (x < 100 && x != 50) x = x * 3;
    printf("%d %c%c\n", x, 'o', 'k');
    return 0;
}

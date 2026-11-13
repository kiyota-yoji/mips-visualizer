# 第06回 例1：if (x == y) z = z + 1;
# x ＝ $s0、y ＝ $s1、z ＝ $s2。等しくないときに飛びこす（bne）
.text
main:
    li   $s0, 5            # x = 5
    li   $s1, 7            # y = 7（5 にすると z が増える）
    li   $s2, 0            # z = 0
    bne  $s0, $s1, L       # x != y なら L へ飛ぶ（z = z + 1 を飛びこす）
    addi $s2, $s2, 1       # z = z + 1（x == y のときだけ通る）
L:
    move $a0, $s2          # z を表示する
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

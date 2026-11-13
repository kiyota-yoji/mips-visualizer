# 第05回 例1：f = (g + h) - (i + j)
# g, h, i, j ＝ $s1〜$s4、f ＝ $s0。一時的な値は $t0・$t1 に置く
.text
main:
    li   $s1, 10           # g = 10
    li   $s2, 20           # h = 20
    li   $s3, 3            # i = 3
    li   $s4, 4            # j = 4
    add  $t0, $s1, $s2     # $t0 = g + h
    add  $t1, $s3, $s4     # $t1 = i + j
    sub  $s0, $t0, $t1     # f = $t0 - $t1

    move $a0, $s0          # f を表示する
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

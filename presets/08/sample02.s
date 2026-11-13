# sample02.s  条件分岐（if 文）（計算機科学の基礎 第08回）
# Python なら:
#   g, h, i, j = 10, 3, 5, 5
#   if i != j:  f = g + h
#   else:       f = g - h
#   print(f, end="")
.text
main:
    li   $s1, 10           # g = 10
    li   $s2, 3            # h = 3
    li   $s3, 5            # i = 5
    li   $s4, 5            # j = 5

    beq  $s3, $s4, ELSE    # i == j なら ELSE へ飛ぶ
    add  $s0, $s1, $s2     # f = g + h（i != j のときだけ通る）
    j    END               # ELSE の部分を飛びこす
ELSE:
    sub  $s0, $s1, $s2     # f = g - h（i == j のときだけ通る）
END:
    move $a0, $s0          # $a0 = f
    li   $v0, 1            # syscall 1 番 = print_int（整数を表示）
    syscall

    li   $v0, 10           # exit
    syscall

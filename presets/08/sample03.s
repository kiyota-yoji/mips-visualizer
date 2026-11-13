# sample03.s  くり返し・配列（計算機科学の基礎 第08回）
# Python なら:
#   array = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
#   i = 0
#   while True:
#       print(array[i], end=" ")
#       if array[i] == 15: break
#       i += 1
.data
array:  .word 1, 3, 5, 7, 9, 11, 13, 15, 17, 19   # 10個の整数（1個 4 バイト）

.text
main:
    li   $s1, 0            # i = 0（配列の添字）
    li   $s2, 15           # 探す値 15
    la   $s3, array        # $s3 = 配列の先頭の番地
Loop:
    sll  $t1, $s1, 2       # $t1 = i × 4（1要素 4 バイト）
    add  $t1, $t1, $s3     # $t1 = array[i] の番地
    lw   $t0, 0($t1)       # $t0 = array[i]

    move $a0, $t0          # array[i] を表示
    li   $v0, 1            # print_int
    syscall
    li   $a0, 32           # 空白（ASCII で 32）を表示
    li   $v0, 11           # syscall 11 番 = print_char（1文字を表示）
    syscall

    beq  $t0, $s2, Exit    # array[i] == 15 ならくり返しを抜ける
    addi $s1, $s1, 1       # i = i + 1
    j    Loop              # Loop へ戻る
Exit:
    li   $v0, 10           # exit
    syscall

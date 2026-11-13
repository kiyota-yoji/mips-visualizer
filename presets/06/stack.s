# 第06回 例5：スタックに退避する（関数の中で $s0・$s1・$ra を使う）
# 確保は $sp を減らす、片づけは増やす。1ワード ＝ 4バイトなので、3ワードで −12
.text
main:
    li   $s0, 100          # 呼び出し元の $s0（関数のあとも 100 のままのはず）
    li   $s1, 200          # 呼び出し元の $s1
    li   $a0, 6
    jal  twice_plus1       # 2 × 6 + 1 を計算する
    move $a0, $v0          # 13 を表示する
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

twice_plus1:
    addi $sp, $sp, -12     # 3ワード（12 バイト）の場所をとる
    sw   $ra, 8($sp)       # $ra を退避
    sw   $s1, 4($sp)       # $s1 を退避
    sw   $s0, 0($sp)       # $s0 を退避
    move $s0, $a0          # 関数の中で $s0・$s1 を自由に使う
    add  $s1, $s0, $s0     # $s1 = 2 × x
    addi $v0, $s1, 1       # 結果 = 2 × x + 1
    lw   $s0, 0($sp)       # $s0 を元に戻す
    lw   $s1, 4($sp)       # $s1 を元に戻す
    lw   $ra, 8($sp)       # $ra を元に戻す
    addi $sp, $sp, 12      # 場所を返す（$sp を元に戻す）
    jr   $ra

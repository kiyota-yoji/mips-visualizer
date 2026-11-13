# sample05.s  関数とスタック（計算機科学の基礎 第08回）
# Python なら:
#   def compute(x):
#       return 2 * x + 1
#   print(compute(5), end="")       # → 11
.text
main:
    li   $a0, 5            # 引数 x = 5
    jal  compute           # compute を呼ぶ

    move $a0, $v0          # 結果を表示
    li   $v0, 1            # print_int
    syscall

    li   $v0, 10           # exit
    syscall

# compute：2 × x + 1 を返す。$s0 を使うので、スタックに退避してから使い、最後に元に戻す
compute:
    addi $sp, $sp, -4      # スタックに 1 ワード（4 バイト）の場所をとる（$sp を減らす）
    sw   $s0, 0($sp)       # $s0 の元の値をスタックに退避

    move $s0, $a0          # $s0 = x
    sll  $t1, $s0, 1       # $t1 = 2 × x（左に 1 ビット）
    addi $v0, $t1, 1       # $v0 = 2 × x + 1

    lw   $s0, 0($sp)       # $s0 を元に戻す
    addi $sp, $sp, 4       # $sp を元に戻す
    jr   $ra               # 呼び出し元へ戻る

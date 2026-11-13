# 計算機科学の基礎 第11回 サンプル1：16ビットの足し算・引き算（符号あり・符号なし）とエンディアン
# mipsy Web で実行し、「data」のデータセグメントを見る。
#   numbers の2つずつを組にして、足し算・引き算の結果を
#   result（符号ありで読み込んで計算）と result_u（符号なしで読み込んで計算）に書く。
.data
array:    .word 0x12345678, -1, 0, 65535                    # エンディアンを見るための4バイトの数
numbers:  .half 1, 2, -1, -2, 65535, 1, -32768, 32767       # 2バイト（half）の数 4組
result:   .half 0, 0, 0, 0, 0, 0, 0, 0                      # 符号ありで計算した結果
result_u: .half 0, 0, 0, 0, 0, 0, 0, 0                      # 符号なしで計算した結果

.text
main:
    la   $s0, numbers       # numbers の先頭の番地
    la   $s1, result        # result の先頭の番地
    la   $s2, result_u      # result_u の先頭の番地

    li   $s3, 0             # 組の先頭の添字 0, 2, 4, 6
    move $a0, $s3
    jal  calc               # numbers[0] と numbers[1]

    addi $s3, $s3, 2
    move $a0, $s3
    jal  calc               # numbers[2] と numbers[3]

    addi $s3, $s3, 2
    move $a0, $s3
    jal  calc               # numbers[4] と numbers[5]

    addi $s3, $s3, 2
    move $a0, $s3
    jal  calc               # numbers[6] と numbers[7]

    li   $v0, 10            # syscall 10：終了
    syscall

# calc：numbers[$a0] と numbers[$a0 + 1] を足し引きして、result と result_u の同じ位置に書く
calc:
    sll  $t3, $a0, 1        # 添字 × 2（half は 2 バイト）
    add  $t0, $s0, $t3      # &numbers[$a0]
    add  $t1, $s1, $t3      # &result[$a0]
    add  $t2, $s2, $t3      # &result_u[$a0]

    # 符号ありで読む（lh：上の16ビットを符号ビットで埋める）
    lh   $t4, 0($t0)        # $t4 = numbers[$a0]
    lh   $t5, 2($t0)        # $t5 = numbers[$a0 + 1]
    add  $t6, $t4, $t5      # 足し算
    sub  $t7, $t4, $t5      # 引き算
    sh   $t6, 0($t1)        # result[$a0]     = 和（下の16ビットだけ書く）
    sh   $t7, 2($t1)        # result[$a0 + 1] = 差

    # 符号なしで読む（lhu：上の16ビットを 0 で埋める）
    lhu  $t4, 0($t0)
    lhu  $t5, 2($t0)
    addu $t8, $t4, $t5      # 足し算（あふれを調べない）
    subu $t9, $t4, $t5      # 引き算（あふれを調べない）
    sh   $t8, 0($t2)        # result_u[$a0]     = 和
    sh   $t9, 2($t2)        # result_u[$a0 + 1] = 差

    jr   $ra                # 呼び出し元に戻る

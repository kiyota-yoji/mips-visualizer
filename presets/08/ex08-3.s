# ex08-3.s  課題 (3)　トランプの表示（関数を使う）（計算機科学の基礎 第08回）
# 学籍番号：
# 氏名：
# 実行結果（Output に出たものを写す）：
#
# 課題：配列 array の要素を前から順に、関数 card に渡して表示します。
#       要素はどれも 1〜13 の整数です。関数 card は、受け取った数 $a0 を次のように表示します。
#         1 → A　　2〜10 → その数　　11 → J　　12 → Q　　13 → K
#       表示のあとに空白を 1 つ入れます。期待する出力：A 3 J Q K 5
#       main のくり返しはできています。関数 card の中身を書いてください。
#       ヒント：文字は syscall 11 番（print_char）で表示する。A = 65、J = 74、Q = 81、K = 75。
#               「$a0 が 1 でなければ次の判定へ」は、比べる数をレジスタに入れてから bne。
.data
array:  .word 1, 3, 11, 12, 13, 5  # 6個の整数
length: .word 6                    # 配列の長さ

.text
main:
    li   $s1, 0           # i = 0（添字）
    lw   $s2, length      # $s2 = 配列の長さ
    la   $s3, array       # $s3 = 配列の先頭の番地
loop:
    beq  $s1, $s2, end    # i == length なら終わり
    sll  $t1, $s1, 2      # $t1 = i × 4
    add  $t1, $t1, $s3   # $t1 = array[i] の番地
    lw   $a0, 0($t1)      # 引数 $a0 = array[i]
    jal  card              # card を呼ぶ
    addi $s1, $s1, 1      # i = i + 1
    j    loop
end:
    li   $v0, 10          # exit
    syscall

# card：$a0 の数をトランプの表示にして出力し、空白を 1 つ出す
card:
    # ここに命令を書く




    li   $a0, 32          # 空白（32）を表示
    li   $v0, 11          # print_char
    syscall
    jr   $ra              # 呼び出し元へ戻る

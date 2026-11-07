# ADR-016：実行を Windows に移し、開発は WSL に残す
- 状態：承認（2026-11-07）／ 決定者：ユーザー（Windows で実行・WSL で開発・置き場・シェル・CUDA の版）＋ Claude 判断（写し方・実装の形）
- 影響する ID：D-06, D-20, D-50, D-59, D-85, D-86, Q-02, Q-06, R-15, FR-007, FR-009, NFR-020, ADR-008, ADR-011

## 状況
WSL の worker から Windows の exe を呼ぶ形は、モデルを `\\wsl.localhost` 越しに読むと遅いので Windows のディスクへ写す必要があり（D-85）、Windows 側のポートにも届かなかった（WSL2 の NAT、ADR-013）。モデルは WSL の仮想ディスクに置かれ、Windows のアプリから扱いにくい。配布の対象も Windows だけ（D-19）。

## 決定
ソースは WSL に置いて開発とテストを続け、実行は Windows の Node で行う。`npm run win` がソースを `%LOCALAPPDATA%\llm-party\app` へ写し、必要なら依存を入れ、ビルドして起動する。データは exe 段階と同じ `%LOCALAPPDATA%\llm-party\` に置く。Electron には包まない（localhost 段階のまま）。

| 項目 | 決定 |
|---|---|
| シェル（Q-06） | Windows PowerShell 5.1 |
| llama-server（Q-02） | 公式の `win-cuda-12.4-x64` |
| 子プロセスの終了 | `taskkill /T /F` |
| sd-cli・ace-lm・ace-synth | `<データ>/runtime/sd`・`<データ>/runtime/ace` の exe |

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| worker は WSL のまま、モデルだけ C: へ | 変更が少ない | Windows の llama-server に届かず、`/mnt/c` 越しの読み込みが遅い。WSL の仕組みが残る | ユーザーが Windows での実行を選択 |
| ソースも Windows へ移す | 写しが要らない | 開発環境を変えることになる | ユーザーが WSL での開発を選択 |
| WSL の `networkingMode=mirrored` で WSL から Windows の exe を呼ぶ | worker は動かさなくて済む | PC 全体の WSL の設定が変わり、ファイル越しの遅さは残る | 根本の解決にならない |

## 影響
- WSL 経由の仕組み（`host-model-cache.ts`・`wslpath`・`image-models` の写し）はなくす。D-85 の「写し」は廃止
- Linux の処理（bash・プロセスグループ・Linux 版の llama-server）は WSL の `npm test` のために残す。テストは WSL で動かす。偽のバイナリとリンクを使うテストは Windows では動かない
- 1 回の変更ごとに `npm run win` で写して起動する。Windows 側に hot reload はない
- `npm ci --ignore-scripts` で入れる。better-sqlite3 は Windows 用の本体を同梱しており、スクリプトを動かすと Visual Studio が要るビルドが走る
- エージェントのコマンドは PowerShell の書き方になる。生成モデルが bash の書き方を出すと失敗し、エラーとして返る

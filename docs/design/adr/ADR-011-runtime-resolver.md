# ADR-011：llama-server の場所は worker が探し、無ければ取得を案内する
- 状態：承認・実装済み（2026-11-06）。上書きのパスが実在しないときの扱いは [ADR-012](ADR-012-invalid-llama-override.md) で改訂／ 決定者：ユーザー（D1 は自動取得を選択）＋ Claude 判断（残りはおすすめのまま）
- 影響する ID：REQ-007, FR-002, FR-003, R-14, ADR-002, ADR-003, ADR-008, ADR-009

## 状況
localhost 段階では、利用者が `LLM_PARTY_LLAMA_BIN` に llama-server のパスを書いて起動する設計だった（[12](../12_localhost_stage.md) の R-14・環境変数の表）。実際に試すと、利用者はパスを知らない・どこに置くかを決める必要がある、という問題が出た。

設計の見直しで分かったこと：
- 配布（exe 段階）では、llama-server は利用者が用意しない。ADR-002 で同梱、ADR-003 で CUDA は追加パックとして自動で取得・検証する（FR-002）。
- localhost 段階だけ「自分で用意する」（R-14）にしていた。これは開発の近道だったが、利用者から見ると「アプリが動かない」になる。
- 取得・検証の仕組み（マニフェスト、DL の再開、sha256 照合）は FR-002・FR-012 に設計済み。localhost でも同じものを使える。

## 決定（案）
llama-server の場所は、worker が次の順で決める。

1. `LLM_PARTY_LLAMA_BIN`（設定されていれば、それを使う。上書き用）
2. `<LLM_PARTY_DATA_DIR>/runtime/llama/<ビルド番号>-<バックエンド>/llama-server`（取得済みのもの）
3. 見つからない → 読み込みを止めず、エンジンの状態を「未導入」にし、画面で取得を案内する

取得は、ggml-org/llama.cpp の Releases から、マニフェストに書いた版（今は b12125）の Linux 版を落とす。sha256 を確かめ、展開して `llama-server` と同じフォルダに cudart の `.so` を置き、`--list-devices` で GPU が見えるか確かめてから登録する。途中の再開・再試行は FR-012 と同じ。

「未導入」は `failed` と分ける。`failed` は「読めたが動かなかった」、「未導入」は「まだ用意していない」。画面は「未導入」のとき、取得のボタンを出す。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| 現状：環境変数で手動指定 | 実装が一番少ない | 利用者がパスを知る必要がある。今回の不具合の原因 | 設計として不適切（利用者の指摘） |
| PATH の `llama-server` を探すだけ | 既に入っている人は楽 | 入っていない人は同じ問題。版が合うかも分からない | 探すだけでは解決しない（補助としてだけ残す） |
| 初回の読み込みで自動取得 | 手間が一番少ない | 知らないうちに数百 MB を落とす。失敗の理由が読み込みの中で出る | 判断は利用者に出す（下の判断 D1） |
| アプリに同梱（ADR-002 と同じ） | オフラインで完結 | CUDA 版は 600MB 以上。WSL は Windows 用 exe の同梱対象外 | ADR-003 の理由（更新が重い） |

## 影響
- `server/binary.ts`（今回の確認関数）は、この resolver の1段目（上書きの確認）として残す
- エンジンに「未導入」の状態を足す。SSE の engine イベントで画面に届く
- 取得の API（例：`POST /runtime/llama/install`）と進捗の表示を足す。FR-012 の DL の仕組みを流用する
- ADR-003 との関係：exe 段階では、CUDA の取得元を自分の Releases に切り替える（R-09 が解決してから）。localhost では upstream を直接使い、再配布の問題を起こさない
- 版の固定（b12125）はマニフェストに書く。版を上げるときはマニフェストだけ変える（R-02 の手順を流用）

## 判断（決定）
| # | 論点 | 決定 |
|---|---|---|
| D1 | 取得の始め方 | **B：初回の読み込みで自動に取得**（利用者の指定。ボタン式ではない） |
| D2 | 取得元 | A：ggml-org の Releases を直接（版は b12125 に固定） |
| D3 | 種類の選び方 | A：`nvidia-smi` が動けば CUDA（ubuntu-cuda-12.8-x64）、無ければ CPU（ubuntu-x64） |
| D4 | 置き場 | A：`<LLM_PARTY_DATA_DIR>/runtime/llama/b12125-<種類>/` |
| D5 | 上限 | A：合計 1GB まで・DL の再試行 3 回 |
| D6 | sd-server | A：今回は llama-server だけ（sd-server は次の変更で同じ resolver を使う） |

## 実装の対応
- 取得の値（URL・サイズ・sha256）は GitHub Releases の API で確かめた値を `server/runtime/manifest.ts` に書いた
- `server/runtime/resolver.ts`：上書き → 取得済み → 未導入
- `server/runtime/installer.ts`：続きからの DL・sha256 照合・再試行・展開・cudart の .so を集める・CUDA の `--list-devices` 確認
- `server/engine.ts`：未導入なら `installing`（進捗つき）で取得してから読み込む。取得の失敗は `failed` で理由を出す
- 画面：取得中の帯と「取得中」の表示（`src/app-data.tsx`・`src/pages/threads/index.tsx`）
- 確かめ：この機器で実際に CUDA 版を取得し、`--list-devices` で RTX 4060 が CUDA0 として見えることを確認した

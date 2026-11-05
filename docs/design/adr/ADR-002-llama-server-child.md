# ADR-002：推論は llama-server を子プロセスで動かす
- 状態：承認 ／ 日付：2026-11-05 ／ 決定者：ユーザー（llama.cpp 同梱を選択）＋ Claude 判断（子プロセスにする点）
- 影響する ID：REQ-001, REQ-007, FR-003, API-100〜102

## 状況
GGUF と LoRA を Windows の CUDA / Vulkan / CPU で動かしたい。外部のインストール（Ollama など）は知人に頼みにくい。

## 決定
ggml-org/llama.cpp の公式ビルドの `llama-server.exe` を同梱し、worker が子プロセスとして起動する。会話は OpenAI 互換の `/v1/chat/completions`。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| node-llama-cpp で worker 内に読み込む | プロセスが1つ減る | ネイティブモジュールを GPU 別にビルド。クラッシュで worker ごと落ちる | 公式ビルドの差し替えだけで版上げしたい |
| Ollama に接続 | アプリが軽い | 別途インストール。自作 GGUF を毎回 Modelfile で登録 | ユーザーが不採用 |
| transformers（Python） | 学習と同じ環境 | 配布物が数 GB | ユーザーが不採用 |

## 影響
- エンジンが落ちても worker と画面は生き残り、読み込み直せる
- 同時に読み込めるのは1プリセット（BR-01）。モデル切替は数十秒かかる
- リクエストごとの LoRA 倍率・思考 ON/OFF は要確認（R-04）

# 10. ER図 / シーケンス図 / 状態遷移図
- プロジェクト：LLM-PARTY ／ 版数：v0.1（2026-11-05） ／ インプット：[08](08_database.md)、[09](09_api/README.md)、[04 状態の定義](04_functional_spec/README.md#状態の定義)

> **3行で**
> 1. ER 図は 08 の 17 テーブル。シーケンスは主要4本（初回・エージェント・評価・更新）とエラー1本（エンジン停止）。
> 2. 状態遷移はターン・ツール呼び出し・ラン・ケース結果・DL・推論エンジンの6つ。
> 3. 値は 04 の「状態の定義」と一致させている。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart LR
  ER[ER 図] --- SEQ[シーケンス 5 本] --- ST[状態遷移 6 つ]
```

## 要点
- [ER図](#er図) → [シーケンス図](#シーケンス図) → [状態遷移図](#状態遷移図) の順。

---

## 詳細
以下は詳細層。

## ER図
```mermaid
erDiagram
  MODELS ||--o{ ADAPTERS : base
  MODELS ||--o{ PRESETS : uses
  PRESETS ||--o{ PRESET_ADAPTERS : has
  ADAPTERS ||--o{ PRESET_ADAPTERS : in
  WORKSPACES ||--o{ THREADS : scopes
  PRESETS |o--o{ THREADS : last_used
  THREADS ||--o{ TURNS : has
  THREADS ||--o{ MESSAGES : has
  TURNS ||--o{ MESSAGES : produces
  TURNS ||--o{ TOOL_CALLS : makes
  TOOL_CALLS ||--o{ FILE_CHANGES : records
  EVAL_SETS ||--o{ EVAL_CASES : has
  EVAL_SETS ||--o{ EVAL_RUNS : runs
  PRESETS |o--o{ EVAL_RUNS : snapshot_of
  EVAL_RUNS ||--o{ EVAL_RESULTS : has
  EVAL_CASES |o--o{ EVAL_RESULTS : graded
  MODELS |o--o{ DOWNLOADS : result
```
DOWNLOADS・RUNTIME_PACKS・SETTINGS は単独のテーブル。

## シーケンス図

### UC-001：初回セットアップ（CUDA あり）
```mermaid
sequenceDiagram
  actor U as 利用者
  participant R as 画面
  participant W as worker
  participant GH as GitHub Releases
  participant HF as Hugging Face
  R->>W: GET /api/system（API-021）
  W->>W: 各 llama-server --list-devices
  W-->>R: NVIDIA あり・vulkan で動作
  U->>R: CUDA パックを追加
  R->>W: POST /api/runtime-packs/install（API-022）
  W->>GH: zip を DL
  W->>W: sha256 照合・展開・--list-devices
  W--)R: runtime.progress（完了・cuda）
  U->>R: おすすめモデルを DL
  R->>W: POST /api/downloads（API-055）
  W->>W: 空き容量 ≥ 5.4GB＋2GB?
  W->>HF: resolve/main/Qwen3.5-9B-Q4_K_M.gguf（Range）
  W--)R: download.progress …
  W->>W: sha256・GGUF 確認 → models、既定プリセット2つ
  W--)R: download.progress（completed）
```

### UC-003：エージェントの作業（承認あり）
```mermaid
sequenceDiagram
  actor U as 利用者
  participant R as 画面
  participant W as worker
  participant L as llama-server
  participant FS as ワークスペース
  U->>R: 「バグを直して」
  R->>W: POST /api/threads/:id/turns（API-035）
  W-->>R: 202 turnId
  W->>L: POST /v1/chat/completions（tools つき）
  L-->>W: tool_calls: read_file
  W->>FS: 読む（自動）
  W->>L: 結果を足して再度
  L-->>W: tool_calls: edit_file
  W--)R: tool.pending（差分プレビュー）
  U->>R: 承認
  R->>W: POST /api/tool-calls/:id/decision（API-038）
  W->>FS: 書く＋file_changes に前後を保存
  W--)R: tool.finished
  W->>L: 結果を足して再度
  L-->>W: 本文（ツールなし）
  W--)R: turn.delta … turn.finished(completed)
```

### UC-007：評価の実行
```mermaid
sequenceDiagram
  actor U as 利用者
  participant R as 画面
  participant W as worker
  participant L as llama-server
  U->>R: 評価セット＋プリセット2つで実行
  R->>W: POST /api/eval-runs（API-077）
  W-->>R: 202 runIds
  loop ランごと（順番）
    W->>L: プリセットを読み込む（FR-003）
    loop ケースごと（300 秒まで）
      alt chat
        W->>L: 1回生成
      else agent
        W->>W: fixture を使い捨てフォルダへコピー
        W->>L: エージェントループ（自動承認）
        W->>W: test の command を実行
      end
      W->>W: 採点（match / test / manual は採点待ち）
      W--)R: eval.progress
    end
    W--)R: eval.finished（passRate）
  end
  U->>R: 採点待ちに ○×
  R->>W: PATCH /api/eval-results/:id（API-081）
```

### UC-008：更新
```mermaid
sequenceDiagram
  actor U as 利用者
  participant R as 画面
  participant M as main
  participant W as worker
  participant GH as GitHub Releases
  M->>GH: latest.yml（10 秒で打ち切り）
  GH-->>M: 新しい版あり
  M--)R: update:status(available)（API-010）
  U->>R: 更新する
  R->>M: update:download（API-005）
  M->>GH: exe を DL（sha512 照合）
  M--)R: update:status(ready)
  U->>R: 再起動して更新
  R->>M: update:install（API-006）
  M->>W: busy?
  W-->>M: 評価中
  M--)R: 「止めて更新しますか」→ 利用者が OK
  M->>W: prepareShutdown
  W->>W: 生成・評価・DL を止め、DB を閉じる、llama-server を止める
  W-->>M: shutdownReady
  M->>M: quitAndInstall（15 秒で入れ替わらなければエラー）
```

### エラー：生成中に推論エンジンが落ちた
```mermaid
sequenceDiagram
  participant R as 画面
  participant W as worker
  participant L as llama-server
  W->>L: /v1/chat/completions（stream）
  L--xW: プロセス終了
  W->>W: engine=failed、ターン=failed、標準エラー末尾を保存
  W--)R: engine(failed)、turn.finished(failed)
  R->>R: 帯に「推論エンジンが停止しました［再読み込み］［ログ］」
  R->>W: POST /api/engine/load（API-024）
```

## 状態遷移図

### ターン
```mermaid
stateDiagram-v2
  [*] --> running
  running --> awaiting_approval: 書き込み・コマンド
  awaiting_approval --> running: 承認 / 却下
  running --> step_limit: 40 回
  step_limit --> running: 続ける
  step_limit --> completed: やめる
  running --> completed: ツールなしで回答
  running --> cancelled: 停止
  awaiting_approval --> cancelled: 停止
  running --> failed: エンジン停止など
```

### ツール呼び出し
```mermaid
stateDiagram-v2
  [*] --> denied: ワークスペース外
  [*] --> running: 読み取り / 自動承認
  [*] --> pending_approval: 書き込み・コマンド
  pending_approval --> running: 承認
  pending_approval --> rejected: 却下
  running --> succeeded
  running --> failed
  running --> timed_out: 120 秒
```

### ラン と ケース結果
```mermaid
stateDiagram-v2
  state ラン {
    [*] --> queued
    queued --> running
    running --> completed
    running --> cancelled: 中止
    running --> failed: エンジン 2 回停止
  }
  state ケース結果 {
    [*] --> pending
    pending --> running_c: 順番
    pending --> skipped: 中止
    running_c --> passed
    running_c --> failed_c: 不一致・テスト失敗
    running_c --> needs_review: 人手採点
    running_c --> timed_out: 300 秒
    running_c --> error: 正規表現不正など
    needs_review --> passed: ○ / 4 点以上
    needs_review --> failed_c: × / 3 点以下
  }
```
`running_c` / `failed_c` は図の都合の名前で、値は `running` / `failed`。

### DL
```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> downloading
  downloading --> retrying: 失敗（3 回まで）
  retrying --> downloading
  retrying --> failed: 3 回失敗
  downloading --> verifying
  verifying --> completed
  verifying --> failed: sha256・形式の不一致
  failed --> downloading: 手動再開
  downloading --> cancelled
  failed --> cancelled
```

### 推論エンジン
```mermaid
stateDiagram-v2
  [*] --> stopped
  stopped --> starting: 読み込み
  starting --> ready: /health 200
  starting --> failed: 60 秒・異常終了
  ready --> starting: 別のプリセット
  ready --> failed: 異常終了
  ready --> stopped: 停止・終了
  failed --> starting: 再読み込み
```

## このドキュメントで決まったこと
- なし

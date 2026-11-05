# 04. 機能仕様
- プロジェクト：LLM-PARTY ／ 版数：v0.1（2026-11-05） ／ インプット：[03_use_cases](../03_use_cases.md)

> **3行で**
> 1. 機能は FR-001〜FR-021。分野ごとに4ファイルに分けた（下の表）。
> 2. 振る舞いの中心は「推論エンジン管理（FR-003）」「エージェントループ（FR-008）」「承認ポリシー（FR-010）」「評価の実行（FR-016）」。
> 3. ログインも権限の区別もない。状態を持つものは5つ（ターン・ツール呼び出し・ラン・ケース結果・DL）で、値は [状態の定義](#状態の定義) に集約。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） | 決まらないと止まるもの |
|---|---|---|---|---|---|
| Q-06 | 未決 | エージェントのコマンドを動かすシェル | A: Windows PowerShell 5.1 / B: cmd / C: Git Bash（入っていれば） | A（全 Windows 10/11 に入っている。モデルも書き慣れている） | FR-009 run_command |
| R-05 | リスク | 9B がツール呼び出しを間違える・同じ操作を繰り返す | — | 形式エラーはモデルに返して直させる。40 回上限（BR-03）で止める | FR-008 |
| R-06 | リスク | 自動要約で大事な指示が落ちる（9B の要約は粗い） | — | システムプロンプトと最初の指示は要約しない（BR-04）。要約前の全文は DB に残し、画面で読める | FR-006 |
| R-10 | リスク | コマンドはワークスペース外にも影響しうる（パスの検査はファイル系ツールだけに効く） | — | コマンドは既定で承認制。自動承認は利用者がスレッドごとに明示して ON。評価では使い捨てフォルダで動かす | FR-009, FR-010 |

## 全体図
```mermaid
flowchart LR
  subgraph F1[準備 models-runtime.md]
    FR001[FR-001 GPU 判定] --> FR002[FR-002 CUDA パック]
    FR012[FR-012 / FR-013<br/>HF の DL・ファイル登録] --> FR014[FR-014 プリセット]
  end
  subgraph F2[会話とエージェント chat-agent.md]
    FR003[FR-003 推論エンジン] --> FR005[FR-005 チャット送信]
    FR005 --> FR006[FR-006 文脈管理]
    FR005 --> FR008[FR-008 エージェントループ]
    FR008 --> FR009[FR-009 ツール] --> FR010[FR-010 承認]
    FR009 --> FR011[FR-011 変更記録・取り消し]
  end
  subgraph F3[評価 eval.md]
    FR015[FR-015 評価セット] --> FR016[FR-016 実行] --> FR017[FR-017 採点] --> FR018[FR-018 比較・推移]
  end
  FR014 --> FR003
  FR016 --> FR008
```
見てほしいところ：評価（FR-016）は会話と同じエージェントループ（FR-008）を再利用する。評価専用の推論経路はない。その他（FR-004, FR-007, FR-019〜021）は [app.md](app.md)。

## 要点
- 機能一覧は [機能一覧](#機能一覧)。詳細は分野ごとのファイルへ。
- 承認ポリシーは表と図で定義した（[FR-010](chat-agent.md#fr-010承認ポリシー)）。
- 評価の採点は3種（[FR-017](eval.md#fr-017採点)）。
- 状態の値は [状態の定義](#状態の定義)。DB・API・状態遷移図と同じ値を使う。

---

## 詳細
以下は詳細層。

## 機能一覧
| ID | 機能名 | 概要 | 関連UC | 優先度 | 詳細 |
|---|---|---|---|---|---|
| FR-001 | GPU 判定・実行バックエンド選択 | 起動時に使えるバックエンドを調べ、CUDA → Vulkan → CPU の順に選ぶ | UC-001 | Must | [models-runtime](models-runtime.md#fr-001gpu-判定実行バックエンド選択) |
| FR-002 | ランタイムパック導入 | CUDA 版 llama-server を DL・検証・展開 | UC-001 | Must | [models-runtime](models-runtime.md#fr-002ランタイムパック導入) |
| FR-003 | 推論エンジン管理 | llama-server の起動・停止・切替・死活確認 | UC-002, UC-007 | Must | [chat-agent](chat-agent.md#fr-003推論エンジン管理) |
| FR-004 | スレッド管理 | 作成・一覧・名前変更・削除・検索 | UC-002 | Must | [app](app.md#fr-004スレッド管理) |
| FR-005 | チャット送信 | ストリーミング・停止・思考の表示 | UC-002 | Must | [chat-agent](chat-agent.md#fr-005チャット送信) |
| FR-006 | 文脈管理 | トークン数の計測、80% で自動要約 | UC-002, UC-003 | Must | [chat-agent](chat-agent.md#fr-006文脈管理) |
| FR-007 | ワークスペース選択 | フォルダを選び、スレッドに結びつける | UC-003 | Must | [app](app.md#fr-007ワークスペース選択) |
| FR-008 | エージェントループ | ツール呼び出しの繰り返し、40 回上限 | UC-003, UC-007 | Must | [chat-agent](chat-agent.md#fr-008エージェントループ) |
| FR-009 | ツール群 | 一覧・読む・検索・書く・置換・コマンド | UC-003 | Must | [chat-agent](chat-agent.md#fr-009ツール群) |
| FR-010 | 承認ポリシー | 自動 / 承認 / 拒否の判定 | UC-003 | Must | [chat-agent](chat-agent.md#fr-010承認ポリシー) |
| FR-011 | 変更記録・差分・取り消し | 書き換え前後の保存、差分表示、元に戻す | UC-003 | Must（取り消しは Should） | [chat-agent](chat-agent.md#fr-011変更記録差分取り消し) |
| FR-012 | HF 検索・DL | 検索、ファイル一覧、DL（再開・再試行・容量確認） | UC-001, UC-004 | Must | [models-runtime](models-runtime.md#fr-012hf-検索dl) |
| FR-013 | ファイル登録 | 手元の GGUF / LoRA を登録（参照 / コピー） | UC-004 | Must | [models-runtime](models-runtime.md#fr-013ファイル登録) |
| FR-014 | プリセット管理 | 作成・編集・複製・削除、Qwen 推奨値 | UC-005 | Must | [models-runtime](models-runtime.md#fr-014プリセット管理) |
| FR-015 | 評価セット管理 | ケース編集、JSONL 取込・書出 | UC-006 | Must | [eval](eval.md#fr-015評価セット管理) |
| FR-016 | 評価の実行 | 1 ケースずつ実行、300 秒で不合格、中止 | UC-007 | Must | [eval](eval.md#fr-016評価の実行) |
| FR-017 | 採点 | match / manual / test | UC-007 | Must | [eval](eval.md#fr-017採点) |
| FR-018 | 比較・推移 | ランどうしの比較、正解率の推移 | UC-007 | Must | [eval](eval.md#fr-018比較推移) |
| FR-019 | 更新 | 起動時確認・DL・適用 | UC-008 | Must | [app](app.md#fr-019更新) |
| FR-020 | 設定 | 置き場・バックエンド・HF トークン・既定値 | UC-001, UC-004 | Must | [app](app.md#fr-020設定) |
| FR-021 | ログ・診断 | ログ 14 日、診断情報の書き出し | UC-002 | Must | [app](app.md#fr-021ログ診断) |

## 権限マトリクス
ログイン・ロールはない。利用者は全機能を使える。代わりに「エージェントが自分でできること」を [FR-010](chat-agent.md#fr-010承認ポリシー) で制限する。

## 状態の定義
| 対象 | 値 | 意味 | 遷移可能先 |
|---|---|---|---|
| ターン `turns.status` | `running` | 生成・ツール実行中 | `awaiting_approval`, `step_limit`, `completed`, `cancelled`, `failed` |
| | `awaiting_approval` | 承認待ち | `running`, `cancelled` |
| | `step_limit` | 40 回上限で停止中 | `running`（続ける）, `completed`（やめる） |
| | `completed` / `cancelled` / `failed` | 終了 | — |
| ツール呼び出し `tool_calls.status` | `pending_approval` | 承認待ち | `running`, `rejected` |
| | `running` | 実行中 | `succeeded`, `failed`, `timed_out` |
| | `denied` | ポリシーで拒否（ワークスペース外など） | — |
| | `rejected` / `succeeded` / `failed` / `timed_out` | 終了 | — |
| ラン `eval_runs.status` | `queued` → `running` | 待ち → 実行中 | `completed`, `cancelled`, `failed` |
| ケース結果 `eval_results.status` | `pending` | 未実行 | `running`, `skipped` |
| | `running` | 実行中 | `passed`, `failed`, `needs_review`, `timed_out`, `error` |
| | `needs_review` | 人手採点待ち | `passed`, `failed` |
| | `passed` / `failed` / `timed_out` / `error` / `skipped` | 終了 | — |
| DL `downloads.status` | `queued` → `downloading` | 待ち → 取得中 | `verifying`, `retrying`, `failed`, `cancelled` |
| | `retrying` | 自動再試行（3 回まで） | `downloading`, `failed` |
| | `verifying` | サイズ・形式の確認 | `completed`, `failed` |
| | `failed` | 失敗（手動再開できる） | `downloading`, `cancelled` |
| 推論エンジン（DB には持たない） | `stopped` / `starting` / `ready` / `failed` | [10 状態遷移](../10_diagrams.md#推論エンジン) | — |

## このドキュメントで決まったこと
- D-24, D-26, D-27, D-29, D-31, D-32, D-35, D-36（[00 決定事項ログ](../00_overview.md#決定事項ログ)）

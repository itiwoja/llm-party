# LLM-PARTY 設計書
> **3行で**：手元の Windows PC で Qwen3.5 9B などの GGUF を動かし、Codex 風の画面で対話・コーディング・評価ができるデスクトップアプリ ／ MVP はローカル対話・ワークスペース内エージェント（承認制）・HF 検索と自作 GGUF / LoRA の登録・プリセット・評価セットの一括実行・GitHub からの自動更新 ／ アプリ内学習・Linux / Mac・クラウド API・MCP・Web 検索・画像入力はやらない ／ 音楽は専用の画面で作る（[music](04_functional_spec/music.md)）／ まず localhost で作って試し、OK が出てから exe にする（[12](12_localhost_stage.md)）

## 🧭 判断してほしいこと（全ドキュメントから集約）
| # | 種類 | 論点 | おすすめ | 決まらないと止まるもの | 詳細 |
|---|---|---|---|---|---|
| Q-02 | 未決（exe 段階で決める） | CUDA パックの版（12.4 / 13.4） | 12.4（古いドライバでも動く。約 650MB） | FR-002、CI | [models-runtime](04_functional_spec/models-runtime.md#-判断してほしいこと) |
| Q-06 | 未決（exe 段階で決める） | exe 段階でコマンドを動かすシェル | Windows PowerShell 5.1 | FR-009 | [04](04_functional_spec/README.md#-判断してほしいこと) |
| R-01 | リスク | 未署名で SmartScreen の警告 | 手順を案内、SignPath は後で | — | [05](05_non_functional.md#-判断してほしいこと) |
| R-02 | リスク | CUDA パックと同梱 llama.cpp の版ずれ | ビルド番号で照合、ずれたら Vulkan＋再 DL | — | [models-runtime](04_functional_spec/models-runtime.md#-判断してほしいこと) |
| R-03 | リスク | PEFT 形式の LoRA は読めない | 登録時に判定して変換を案内 | — | 同上 |
| R-04 | リスク | リクエストごとの LoRA 倍率の実機確認が残る（思考 ON/OFF は確認済み） | 手元の LoRA で確かめる。だめなら読み込み直し | FR-003, FR-005 | [chat-agent](04_functional_spec/chat-agent.md#-判断してほしいこと) |
| R-05 | リスク | 9B のツール誤用・繰り返し | エラーを返す・40 回上限 | — | [04](04_functional_spec/README.md#-判断してほしいこと) |
| R-06 | リスク | 自動要約で指示が落ちる | 最初の指示とシステムは残す | — | 同上 |
| R-07 | リスク | 外への通信がある（HF・GitHub） | 通信先を明示、本文は送らない | — | [05](05_non_functional.md#-判断してほしいこと) |
| R-08 | リスク | ネイティブモジュールのビルド | asarUnpack と検査 | — | [07](07_architecture.md#-判断してほしいこと) |
| R-09 | リスク | cudart の再配布条件 | 公開前に確認、だめなら公式から直接 DL | FR-002 | [models-runtime](04_functional_spec/models-runtime.md#-判断してほしいこと) |
| R-10 | リスク | コマンドはワークスペース外にも影響しうる | 承認制、自動承認は明示 ON のみ | — | [04](04_functional_spec/README.md#-判断してほしいこと) |
| R-19 | リスク | `LLM_PARTY_LLAMA_BIN` の打ち間違いでも読み込みが止まらず、別の本体が動くことがある（未取得なら約 780MB の自動取得も始まる） | 警告で気づけるようにする（CP-313） | — | [ADR-012](adr/ADR-012-invalid-llama-override.md) |
| R-15 | リスク | Windows 固有の動きは exe 段階まで確かめられない | exe 段階の確認に入れる | exe 段階 | 同上 |
| R-16 | リスク | 他のサイトから localhost の API を叩かれる | トークン＋Host・Origin の確認 | — | 同上 |
| Q-14 | 未決 | MOSS-Image の DiT の版：unsloth の UD-Q4_K_XL か、leejet の MOSS-Image-SFT-GGUF か | unsloth の UD-Q4_K_XL（手順が検証済みの card に合う） | API-097 の部品一覧 | [ADR-010](adr/ADR-010-moss-image-recipe.md) |
| Q-15 | 未決 | 既定のエンコーダ（Qwen3.5-9B Q8_0 は約 9GB 級）を、小さい量子化に替えるか | 替えない（品質を優先）。8GB 機は後で決める | R-18 の扱い | [ADR-010](adr/ADR-010-moss-image-recipe.md) |
| R-17 | リスク | 同梱の sd-server を master-975 以降に上げても、MOSS の複数ファイル指定が未確認 | 実機で1枚生成を確かめる。だめなら版を上げ直す | FR-012 | [ADR-010](adr/ADR-010-moss-image-recipe.md) |
| R-18 | 対処済み | 既定の組み合わせは 8GB の GPU に一度に載らない | `--max-vram 5.5` で順に載せ替えて全部 GPU で動かす（D-85）。実機 RTX 4060 8GB で確認 | FR-012 | [ADR-010](adr/ADR-010-moss-image-recipe.md) |
| R-20 | リスク | acestep.cpp は公式の配布物がなく、作者のサイトの `/temp/` の Windows 版を使っている。sha256 の公開もなく、場所が消える恐れがある | 版 07abf07 の sha256 を ADR-013 に控えた。exe 段階までに自前のビルドに切り替える | FR-012 | [ADR-013](adr/ADR-013-acestep-cli.md) |
| R-21 | リスク | この Windows 版には cublas64_13.dll が無く CUDA が読めないので、合成は Vulkan、LM は CPU で動く。LM は Vulkan だと結果が壊れる | LM は常に CPU を指定。合成の結果は CPU と波形が一致することを確認済み。CUDA 版が手に入れば見直す | FR-012 | [ADR-013](adr/ADR-013-acestep-cli.md) |
| R-22 | リスク | XL の VRAM の山は 6.8GB で、8GB の GPU の余裕は約 1.4GB。他のアプリが GPU を使うと失敗しうる | 失敗しても編集中の内容を残し、CP-353 で案内する | — | [music](04_functional_spec/music.md#-判断してほしいこと) |
| R-23 | リスク | AI の下書きは説明とずれることがあり、長さも守らない。長い歌詞を短い曲に渡したときの歌われ方は未確認 | 手直しの土台と位置づけ、長さは画面の指定を優先。実装時に耳で確かめる | FR-023 | [music](04_functional_spec/music.md#-判断してほしいこと) |

番号の欠け（Q-01, Q-03, Q-04, Q-05, Q-07, Q-08, Q-09）は決着済み → [00 決定事項ログ](00_overview.md#決定事項ログ)（D-55, D-33, D-43, D-46, D-42, D-38, D-56）。Q-02 と Q-06 は exe 段階で決める（D-59）。

## 全体図（C4 レベル1：コンテキスト）
exe 段階の最終形。localhost 段階の図は [12](12_localhost_stage.md#全体図)。
```mermaid
flowchart LR
  U([自分・知人]) --> S[LLM-PARTY<br/>Windows アプリ<br/>llama-server 同梱]
  S -->|検索・GGUF の DL| HF[(Hugging Face)]
  S -->|更新・CUDA パック| GH[(GitHub Releases<br/>itiwoja/llm-party)]
  DEV([開発者]) -->|v* タグ| GA[GitHub Actions] --> GH
```

## 読む順番
| 目的 | 読むもの | 所要 |
|---|---|---|
| 画面の見た目と文言を知りたい | [ui/README](ui/README.md) | 5分 |
| 全体像だけ知りたい | この README → [11_tech_spec](11_tech_spec.md) の要約層 | 5分 |
| 何を作るか判断したい | [01](01_requirements.md) → [02](02_user_stories.md) の要約層 | 10分 |
| 振る舞いを知りたい | [04 README](04_functional_spec/README.md) → [chat-agent](04_functional_spec/chat-agent.md) → [eval](04_functional_spec/eval.md) → [music](04_functional_spec/music.md) | 25分 |
| 実装する | [12](12_localhost_stage.md) → [07](07_architecture.md) → [08](08_database.md) → [09](09_api/README.md) → [10](10_diagrams.md) | — |

## 主要な設計判断（ADR）
| ADR | 決定 | 状態 |
|---|---|---|
| [ADR-001](adr/ADR-001-electron-worker.md) | Electron＋utilityProcess の worker（DC-Designer 準拠） | 承認 |
| [ADR-002](adr/ADR-002-llama-server-child.md) | 推論は llama-server を子プロセスで | 承認 |
| [ADR-003](adr/ADR-003-gpu-runtime.md) | Vulkan＋CPU 同梱、CUDA は追加パック | 承認 |
| [ADR-004](adr/ADR-004-sqlite.md) | 保存は SQLite | 承認（ドライバは better-sqlite3。D-55） |
| [ADR-005](adr/ADR-005-approval-policy.md) | 読み取り自動・書き込みとコマンドは承認・外は拒否 | 承認 |
| [ADR-006](adr/ADR-006-auto-compaction.md) | 文脈 80% で自動要約（直近 6 メッセージは残す） | 承認 |
| [ADR-007](adr/ADR-007-update-flow.md) | 起動時に確認、DL と適用は利用者の操作 | 承認 |
| [ADR-008](adr/ADR-008-localhost-first.md) | 先に localhost で試し、OK が出てから exe にする | 承認 |
| [ADR-009](adr/ADR-009-sd-server-child.md) | 画像生成は sd-server を子プロセスで動かす | 承認 |
| [ADR-010](adr/ADR-010-moss-image-recipe.md) | MOSS-Image は部品のレシピとして複数ファイルで動かす | 承認 |
| [ADR-011](adr/ADR-011-runtime-resolver.md) | llama-server の場所は worker が探し、無ければ自動に取得する | 承認・実装済み（無効な指定の扱いは ADR-012 で改訂） |
| [ADR-012](adr/ADR-012-invalid-llama-override.md) | `LLM_PARTY_LLAMA_BIN` のパスが実在しなければ、警告して無視する | 承認・実装済み |
| [ADR-013](adr/ADR-013-acestep-cli.md) | 音楽生成は acestep.cpp の CLI を生成のたびに起動する | 承認・実装済み |
| [ADR-014](adr/ADR-014-xl-turbo-q8.md) | 音楽の DiT を XL turbo Q8 に置き換える（8GB の GPU で 240 秒まで実機で確認） | 承認 |
| [ADR-015](adr/ADR-015-music-page.md) | 音楽は専用の画面に一本化し、曲をスレッドから切り離す | 承認 |

## 最近の変更
- 2026-11-07：音楽専用の画面と XL turbo への置き換えを設計（D-79〜D-83、[変更レポート](changes/2026-11-07-music-studio.md)）。実装はこれから
- 2026-11-07：音楽生成に対応（D-78、[ADR-013](adr/ADR-013-acestep-cli.md)、[変更記録](changes/2026-11-07-music-generation.md)）。R-20、R-21 を追加
- 2026-11-07：`LLM_PARTY_LLAMA_BIN` の無効な指定で読み込みを止めないように変更（[ADR-012](adr/ADR-012-invalid-llama-override.md)、[変更レポート](changes/2026-11-07-invalid-llama-override.md)）。R-14 を決着として閉じ、R-19、D-74、CP-313 を追加
- 2026-11-07：入力欄で思考の強さを選べるように変更（D-76。[変更記録](changes/2026-11-07-thinking-effort.md)）
- 2026-11-06：localhost 段階の実装を反映。D-64〜D-68（容量は 10 進、内部の値、システムプロンプト、新しいスレッドで続ける、実装で足した文言）、API-030・031・050・056 の追記、CP-208 以降
- 2026-11-06：Q-01・Q-09 が決着（D-55, D-56）。AI の回答の Markdown 表示（D-57、CMP-022）、日本語検索（D-58）、localhost 段階の開発環境（D-59）を追加
- 2026-11-06：開発を2段階に変更。先に localhost で試し、OK が出てから exe にする（[12](12_localhost_stage.md)、[ADR-008](adr/ADR-008-localhost-first.md)、D-49〜D-54）。API-093〜094 と R-14〜R-16 を追加
- 2026-11-06：[UI 設計書](ui/README.md) v0.1 を追加。Q-05 決着（D-46）、新規作成の形（D-47）、文言の正本（D-48）、`turn.usage` に `tokensPerSecond` を追加

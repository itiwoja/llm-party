# 変更記録：MOSS-Image を部品のレシピとして動かす（2026-11-06）

> **3行で**：MOSS-Image（DiT・テキストエンコーダ・VAE・トークナイザ）を「レシピ」として一括で DL し、1 つの画像モデルとして登録する ／ 推論は sd-server に複数ファイルを渡す（ADR-010）／ 書き換え・Heretic 版・FLUX/SD3 は今回入れない

## 依頼と決定
| 項目 | 決定 | 根拠 |
|---|---|---|
| 目的 | 利用者がモデルを入れて、プロンプトを打つと画像が生成される | 依頼 |
| 対象 | MOSS-Image のみ | ユーザー回答（既出） |
| 部品の取り方 | レシピとして一括。利用者は選ばない | ユーザー回答（既出） |
| テキストエンコーダ | Qwen3.5-9B 系（unsloth の Q8_0） | ユーザー回答（既出）＋ model card の手順 |
| プロンプトの書き換え | 今回は入れない | ユーザー回答（既出） |
| 同梱 sd-server | master-975 以降に上げる | model card の記載（未検証） |
| DiT・VAE の版 | unsloth の UD-Q4_K_XL・FP8 の VAE | Claude 判断（見直し可・Q-14） |

## 差分（ID 単位）
| 対象 | 変更 | 影響 |
|---|---|---|
| [D-73](../00_overview.md) | 新規。MOSS-Image をレシピで対応 | FR-012 |
| [D-72](../00_overview.md) | 変更なし。単一ファイルの画像は従来どおり。FLUX・SD3 は外したまま | FR-012 |
| [ADR-010](../adr/ADR-010-moss-image-recipe.md) | 新規。部品のレシピ化 | FR-012, API-097〜098 |
| [FR-012 の DL の種類](../04_functional_spec/models-runtime.md) | `image-set` を追加 | FR-012 |
| [API-097](../09_api/worker.md#画像生成d-72) | レシピの DL を始める（新規） | FR-012, D-73 |
| [API-098](../09_api/worker.md#画像生成d-72) | レシピの一覧（新規） | FR-012, D-73 |
| [API-095〜096](../09_api/worker.md#画像生成d-72) | 変更なし。画像モデルの `modelId` をそのまま使う | — |
| [REQ-004 の trace 行](../00_overview.md) | API-095〜098 を足す | REQ-004 |
| [README の判断](../README.md) | Q-14, Q-15, R-17, R-18 を追加 | — |

## 未確認・未決
- **実機の sd-server で MOSS を生成していない。** 根拠は unsloth の model card（sd-cli の例）と二次情報のみ。sd-server が sd-cli と同じ複数ファイル指定を受けるかは未確認（R-17）
- 既定の組み合わせは 8GB の GPU に載らない見込み（R-18）
- エンコーダは unsloth の再配布版。Qwen 公式の GGUF は確認していない
- 今回の Heretic DHQ GGUF はエンコーダとして検証していない。既定にしない（Q-15 の周辺）
- 書き換え（プロンプトの拡張）は今回入れない。Heretic 版はその用途で使える可能性がある

## 影響範囲のまとめ（ID）
- 新規：D-73, ADR-010, API-097, API-098
- 変更：FR-012（DL の種類に `image-set`）、REQ-004（trace 行）、判断 Q-14・Q-15・R-17・R-18
- 変更なし：D-72, API-095〜096, ADR-009, TBL（画像モデルの行は既存の `models` を使う。部品の場所の列は実装時に決める）

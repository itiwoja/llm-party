# 変更記録：画像生成モデルをアプリ内で使えるようにする（2026-11-06）

> **3行で**：画像（text-to-image）の単一 `.safetensors` を DL して「画像モデル」に登録し、スレッドの画像モードで生成して履歴に残す ／ 推論は sd-server の子プロセス（ADR-009）／ チャットと画像は同時に1つだけ常駐（チャットを止める）

> 注：D-17「画像入力はやらない」は変えない。今回は**画像の出力**（生成）の話。

## 依頼と決定
| 項目 | 決定 | 根拠 |
|---|---|---|
| 置き場 | チャットのスレッド内。入力欄のモデル選択で画像モデルを選んで送る（画像モードのボタンは後から外した） | ユーザーが選択（推奨の専用画面とは別）。切り替えは1か所にしたいという後からの要望 |
| 生成の上限 | 1 枚 300 秒。過ぎたら sd-server に取り消しを頼んで失敗 | ユーザーが 300 秒（推奨）を選択 |
| 同時常駐 | 画像モデルを読むとき、チャットの llama-server を止める | ユーザーが推奨を選択。VRAM 不足を避ける |
| 推論エンジン | stable-diffusion.cpp の sd-server（ADR-009） | ADR-002 と同じ配布の形に合う |
| 対応モデル | 分割していない単一の `.safetensors`（SD 1.x・SDXL など） | FLUX・SD3 は複数ファイルの指定が要るので v1 では外す |

## 差分（ID 単位）
| 対象 | 変更 | 影響 |
|---|---|---|
| [D-72](../00_overview.md) | 画像モデルをアプリ内で動かす（D-71 の一部を覆す） | FR-012 |
| [ADR-009](../adr/ADR-009-sd-server-child.md) | sd-server を子プロセスにする | — |
| [FR-012](../04_functional_spec/models-runtime.md#fr-012hf-検索dl) | `image` の DL を足す | FR-012 |
| [API-095〜096](../09_api/worker.md#画像生成d-72) | 生成の開始・PNG の取得（新規） | — |
| `server/db/schema.ts` | v3：`models.kind`（DB の列。API では `use`）、`images` 表 | TBL |
| `server/safetensors.ts` | ヘッダーだけ読んで形式を確かめる（新規） | FR-012 |
| `server/hf/downloads.ts`・`names.ts`・`routes/hf.ts` | `kind: image`（単一の .safetensors だけ） | FR-012 |
| `server/image-engine.ts` | sd-server の子プロセス、読み込み・生成・時間切れの取り消し（新規） | FR-012 |
| `server/images.ts`・`routes/images.ts` | 生成の進行、スレッドへの画像の追加、PNG の返却（新規） | API-095〜096 |
| `server/engine.ts`・`context.ts` | 読み込み前に sd-server を止める（`beforeLoad`） | ADR-009 |
| `server/store/presets.ts`・`routes/engine.ts`・`routes/models.ts` | 画像モデルはチャットのプリセット・読み込み・LoRA の基底に使えない | — |
| `src/pages/threads/index.tsx`・`ImageMessage.tsx`・`Conversation.tsx` | 画像モード（ボタン・画像モデル選択・表示） | CP-（未採番） |
| `src/pages/models/HfTab.tsx` | 画像リポジトリの単一 `.safetensors` を `image` で取る | FR-012 |
| `docs/guide/hf-models.md` | 画像の取り方を書き直す | — |

## テスト
- `tests/images.test.ts`：偽の sd-server（`tests/fixtures/fake-sd.mjs`）で、読み込み・生成・時間切れ・起動失敗、スレッドへの画像の追加、画像モデルのプリセット拒否
- `tests/downloads-image.test.ts`：DL の登録、分割・GGUF の拒否、safetensors でないファイルの失敗
- `tests/db.test.ts`：テーブル数を 18 に更新

## 数字（確認待ち）
- 幅・高さ：既定 512、64〜2048、8 の倍数
- ステップ数：既定 20、1〜100
- シード：既定 -1（ランダム）
- sd-server の読み込みの上限：180 秒（設計にない仮の値）

## 未確認・未決
- **実機の sd-server では動かしていない。** 実行ファイルの実行が許可されなかったため、ソースと公式 API の文書から作った。Windows の CUDA 版での確認が要る
- 生成の取り消しボタンは作っていない（時間切れだけ）
- スレッドを消しても生成した PNG のファイルは残る（DB の行は消える）
- 画像の文言は `src/pages/threads/copy.ts` に置いた。`ui/08_copy.md` へはまだ反映していない
- 画面は `npm start` で確認した（2026-11-07）。このとき CSP が `blob:` の画像を止めて表示されない不具合が見つかり、`server/csp.ts` で直した
- FR・CP の新規番号は未採番

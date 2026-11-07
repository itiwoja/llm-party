# 変更記録：画像生成を全部 GPU にし、途中の画像を見せる（2026-11-07）

> **3行で**：WSL の Vulkan 版は GPU を見つけず CPU で動いていたので、Windows の CUDA 版 `sd-cli.exe` に替える ／ テキストエンコーダも GPU で動かす ／ 生成中はスレッドに途中の画像とステップ数を出す

## 依頼と決定
| 項目 | 決定 | 根拠 |
|---|---|---|
| 推論を見る | 途中の画像とステップ数 | ユーザー回答。画像生成には言語モデルが無く、チャットの「思考」にあたる文章が無い |
| 処理の置き場 | 常に全部 GPU | ユーザー回答 |
| 途中の画像の方式 | `proj`（毎ステップ） | Claude 判断。VRAM を使わない。出力は 64×64 |
| VRAM の予算 | 部品モデルは `--max-vram 5.5` | ユーザー確認済み。絞らないとエンコーダの作業領域が足りず失敗した |
| モデルの読み先 | Windows のディスクの写し | ユーザー回答。20 ステップが約 80〜93 秒になった |

## 差分（ID 単位）
| 対象 | 変更 | 影響 |
|---|---|---|
| [D-85](../00_overview.md) | 新規 | FR-012 |
| R-18 | 対処済みにする | ADR-010 |
| API-115 | `step`・`totalSteps`・`previewSeq` を足す | FR-012 |
| API-116 | 新規。途中の画像を返す | FR-012 |
| API-099 `image` | `progress` に `step`・`totalSteps`・`previewSeq` を足す | SCR-001 |
| CP-358, CP-359 | 新規 | PG-001 |
| `server/image-engine.ts` | `--backend te=cpu` をやめる。sd-cli の進捗行とプレビューのファイルを読む | — |
| `src/pages/threads/ImagePreview.tsx` | 新規 | — |
| `server/host-model-cache.ts` | 新規。Windows のディスクの写しを作る・消す | — |

## 影響（既知）
- `\\wsl.localhost` 経由の読み取りが遅いので（512×512・4 ステップで約 7 分のうち約 6.5 分が読み込み）、Windows の exe のときは `%LOCALAPPDATA%\llm-party\image-models` に写して読ませる。モデル約 10GB ぶん Windows のディスクを使い、初回だけ 2 分ほど写す時間がかかる。写せなければ元のパスで動く。モデルを消すと写しも消す。
- 読み込み中はステップが無いので「画像を生成しています…」のまま。
- `LLM_PARTY_SD_BIN` は利用者の環境の設定。変えてアプリを起動し直すまで効かない。
- 音楽の ace-lm は CPU のまま（ADR-013）。ユーザーも CPU のままでよいと判断した。

## 確かめ
- `npm test`、`npm run typecheck`、`npm run build` が通る
- 実機（RTX 4060 8GB、`sd-cli.exe`、MOSS-Image、512×512）：サンプリングは 1 ステップ約 2 秒（CPU 版は約 95 秒）。`ImageEngine` 経由で 4 ステップ分の途中の画像が届き、最後の画像も出た
- 画面の表示は実機で未確認

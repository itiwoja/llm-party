# 変更記録：実行を Windows へ移す（2026-11-07）

> **3行で**：worker・llama-server・画像・音楽を Windows で動かす ／ 開発とテストは WSL のまま ／ `npm run win` で写して起動する

## 依頼と決定
| 項目 | 決定 | 根拠 |
|---|---|---|
| 実行する場所 | Windows | ユーザー指定 |
| 開発する場所 | WSL | ユーザー指定 |
| 置き場 | `%LOCALAPPDATA%\llm-party` | ユーザー回答。D-06 と同じ |
| シェル | Windows PowerShell 5.1 | ユーザー回答。Q-06 の決着 |
| CUDA の版 | 12.4 | ユーザー回答。Q-02 の決着。Windows 用の 12.8 は配られていない |
| 消すモデル | Sulphur-2-base、LTX-2.3、gemma-3-12b、SD 1.5 | ユーザー回答。前の3つは未登録で参照がなく、SD 1.5 は MOSS-Image に置き換え済み |

## 差分（ID 単位）
| 対象 | 変更 | 影響 |
|---|---|---|
| [D-86](../00_overview.md) | 新規 | D-50, D-59, D-85 を改める |
| [ADR-016](../adr/ADR-016-windows-runtime.md) | 新規 | ADR-008, ADR-011 |
| Q-02, Q-06 | 決着 | FR-002, FR-009 |
| R-15 | 対処済みにする | 12 |
| CP-202 | 「Windows のパスを貼り付け」に変える | PG-* |
| `server/process-tree.ts` | 新規。子孫の終了と PID の確認を OS ごとに分ける | engine, image-engine, shell |
| `server/agent/shell.ts` | PowerShell の起動を足す | FR-009 |
| `server/agent/paths.ts` | Windows の FR-007 の表、大文字小文字を区別しない比較、相対パスの区切りは `/` | FR-007, FR-010 |
| `server/runtime/*` | Windows 版の取得元、zip の展開、`.dll` の収集 | ADR-011 |
| `server/host-model-cache.ts` | 削除 | D-85 |
| `scripts/win.sh`, `scripts/win-start.ps1` | 新規。`npm run win` | 12 |

## 影響（既知）
- 8787 を WSL の worker が使っていると Windows の worker と衝突する。WSL では `npm run dev` を動かさない
- `-EncodedCommand` はエラー出力が CLIXML になるので使わない
- コマンドの本文は base64 にしてコマンドラインで渡すので、長さの上限は英数字で約 2 万字、日本語で約 8 千字
- ワークスペースは Windows のパスで登録する。WSL の中のフォルダは `\\wsl.localhost\...` なら指定できるが遅い

## 確かめ
- WSL：`npm run typecheck` と `npm test`（436 件）が通る
- 実機（RTX 4060 8GB、Windows の Node 24.19）：
  - llama-server の自動取得（CUDA 12.4）と Qwen3.5 の読み込みが約 1 分
  - エージェントが PowerShell で `Get-ChildItem` を動かして答える
  - 画像は MOSS-Image、512×512・8 ステップで 47 秒。ステップ数が届く
  - 音楽は ACE-Step 1.5 XL、15 秒の曲を 48 秒。作詞は CPU、音声は Vulkan
  - PowerShell の日本語・終了コード・時間切れ・取り消しで子孫まで止まる
  - 移した DB の会話 19 件と曲を読める
  - `npm run win` の起動と、Ctrl+C の後に Windows の worker が残らない
- 移したファイルは SHA-256 が元と一致してから消した
- 未確認：画面の操作（ブラウザでは未確認）。強制終了の後に残った PID の片付け（`processLabel` の Windows の経路）
- テストは WSL で動かす。Windows の vitest は偽のバイナリ（`#!/bin/sh`）とリンクの権限のため動かない

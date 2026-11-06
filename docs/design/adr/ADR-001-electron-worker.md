# ADR-001：Electron＋utilityProcess の worker で作る（DC-Designer 準拠）
- 状態：承認 ／ 日付：2026-11-05 ／ 決定者：ユーザー（DC-Designer を参考にと指定）
- 影響する ID：REQ-008, FR-019, NFR-010〜012, 07 全体

## 状況
exe 化と GitHub からの更新を、すでに配布している DC-Designer と同じ形で行いたい。推論・DL・エージェントは重く、画面を固めたくない。

## 決定
Electron 45（main・sandbox の画面・utilityProcess の worker）、electron-builder の NSIS、electron-updater を使う。重い処理は全部 worker に置く。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Tauri | 配布物が小さい | Rust 側を新しく書く。DC-Designer の資産が使えない | 実績のある構成を流用したい |
| main で全部動かす | プロセスが減る | 推論や DL で窓が固まる | 体験が悪い |

## 影響
- DC-Designer の `desktop/`・`scripts/build-desktop.mjs`・`release-windows.yml` の考え方を流用できる
- Electron に包むのは exe 段階。その前に Electron なしの localhost 段階がある（[ADR-008](ADR-008-localhost-first.md)）
- インストーラーは Electron の分だけ大きい（llama.cpp の Vulkan・CPU 版を足しても 100MB 台の見込み）

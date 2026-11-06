# 変更記録：llama-server の場所を worker が探す・取得を案内する（2026-11-06）

> **3行で**：利用者が `LLM_PARTY_LLAMA_BIN` にパスを書く設計をやめる ／ worker が上書き → 取得済み → 未導入の順で決め、未導入なら初回の読み込みで自動に取る ／ 判断 D1〜D6 は ADR-011 のとおり決定（D1 は自動取得）

## 依頼と決定
| 項目 | 内容 | 根拠 |
|---|---|---|
| 指摘 | モデル読み込みが失敗し、「Path が分からない」。設計として利用者にパスを書かせるのはおかしい | ユーザーの指摘 |
| 見直しの結論 | localhost 段階でも FR-002（ランタイムの取得・検証）の仕組みを使い、環境変数は上書き用にする | 配布段階は同梱・取得で、localhost だけ手動にしていた（R-14）ことが原因 |
| 決めたこと | ADR-011 を承認。判断 D1 は自動取得（利用者が選択）、D2〜D6 はおすすめどおり | 判断は ADR-011 の表 |

## 差分（ID 単位）
| 対象 | 変更 | 影響 |
|---|---|---|
| [ADR-011](../adr/ADR-011-runtime-resolver.md) | 承認・実装済み | R-14, FR-002, FR-003 |
| `server/runtime/manifest.ts`（新規） | 版 b12125 の取得先（CUDA・CPU）。サイズと sha256 は GitHub Releases の値 | FR-002 |
| `server/runtime/resolver.ts`（新規） | 上書き → 取得済み → 未導入。NVIDIA の有無で種類を決める | FR-003 |
| `server/runtime/installer.ts`（新規） | 続きからの DL、sha256 照合、再試行 3 回、展開、cudart の .so、CUDA の `--list-devices` 確認。途中の失敗では一時フォルダを消す | FR-002, FR-012 |
| `server/engine.ts` | 状態 `installing`（進捗つき）を足す。未導入なら取得してから読み込む。種類は取得したものに合わせる | FR-003 |
| `server/local.ts` | 未指定のときの起動時の表示を、自動取得の案内に変える | — |
| `server/binary.ts` | 変更なし（上書きのパスの確認に使う） | — |
| 画面（`src/app-data.tsx`・`src/pages/threads/index.tsx`・`src/copy.ts`・`src/types.ts`） | 取得中の帯・ラベル・進捗の表示 | — |
| `tests/runtime.test.ts`（新規）・`tests/engine.test.ts` | 解決の順、取得・展開・cudart・sha 不一致・上限・中断。取得中→読み込み、取得の失敗 | — |

## 実装の判断（ADR に無かった点）
- **`LLM_PARTY_BACKEND` の扱い**：上書きのパスを使うときだけ、この設定が効く。自動の取得では、NVIDIA の有無（`nvidia-smi`）で CUDA か CPU を決める（D3）。設定の値は無視される
- **取得の中断**：取得の途中で「停止」を押しても止まらない（読み込みの順番の待ちに入る）。中断は次の変更で足す
- **sd-server**：今回は変えない（D6）。画像生成は従来どおり `LLM_PARTY_SD_BIN`

## 確かめ
- `npx tsc --noEmit` が通る／`npx vitest run` 全件 341 件が通る／`npx vite build` が通る
- 実物の確認：この機器で CUDA 版を実際に取得した（約 780MB）。sha256 照合・展開・cudart の .so の配置・`llama-server --list-devices` で **RTX 4060 が CUDA0 として見える**ことを確かめた。取得先は作業用フォルダで、リポジトリの `data/` は触っていない
- 実際のアプリでモデルを読み込むところ（初回の自動取得の画面表示を含む）は未確認。次はアプリを起動して、画面で確かめる
- 中断（signal）と sha 不一致の処理は、テストで確かめた（ローカルの HTTP サーバーと小さな tar.gz）

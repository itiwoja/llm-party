# 09. アプリアイコン
> 版：v0.1（2026-11-06）｜ 関連：[03 トークン](03_tokens.md)

> **3行で**
> - モチーフは「並んだ三人」。高さの違う3本の柱で、比べるプリセットを表す。
> - 一番高い柱だけライムにする。背景は暗いまま、ライトテーマでも同じ絵を使う。
> - 作るのは .ico と GitHub 共有画像の仕様と指示文まで。画像の生成はしない。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） | 決まらないと止まるもの |
|---|---|---|---|---|---|
| R-12 | リスク | 3本の柱は棒グラフのアイコンに見えやすい。頭を足さない形をユーザーが選んだ | — | タスクバーで実物を見て、分析ツールと紛らわしければ見直す | ICN-001 |

## 全体図
```
180px                32px
┌──────────────┐     ┌──────┐
│        ▓▓    │     │   ▓  │
│  ██    ▓▓    │     │ █ ▓  │
│  ██    ▓▓ ██ │     │ █ ▓ █│
│  ██    ▓▓ ██ │     │ █ ▓ █│
└──────────────┘     └──────┘
■ #141516 背景  □ #ECEDEE 柱  ■ #C8F031 一位
```

## 要点
- 絵柄は記号。平らな塗りで影なし。
- 色は 03 のトークンから3役だけ。
- 16px では輪郭だけ残れば足りる。
- ICN は2つ。
- Windows の必要サイズは実装時に electron-builder の最新の説明で確かめる。

---

## 詳細

### モチーフと絵柄
| 物 | 動き | 感情 | 絵柄 | 選んだ理由 |
|---|---|---|---|---|
| 三人組 | 競う | 高揚 | 記号 | ユーザー回答（D-25）。計測器の平らな作りとそろう |

| 案 | モチーフ | 目印 | 結果 |
|---|---|---|---|
| A L 字の目盛り | 曲尺＋測る＋手応え | L の内側の切り欠きとライムの印 | 不採用 |
| B 振れる針 | 計器の針＋振れる＋手応え | 右上へ振れるライムの針 | 不採用 |
| C 並んだ三人 | 三人組＋競う＋高揚 | 一番高い柱だけライム | 採用 |

### 作りの仕様
| 項目 | 値 |
|---|---|
| 主役 / 小物 | 高さの違う3本の柱 / なし |
| 部品の数 | 3 |
| 占める広さ | 72% |
| 目印 | 中央の一番高い柱だけ差し色 |
| 色 | 背景 `--ink-950` #141516 / 柱 `--ink-100` #ECEDEE / 目印 `--lime-400` #C8F031 |
| 光・影 | なし |
| 角の丸み | 柱の角は全体の 4%（`--radius` の性格に合わせる） |
| 入れないもの | 文字・細い線・細かい模様・既存のロゴやキャラクター |

コントラスト：柱と背景 15.60:1、目印と背景 13.90:1（`contrast.py`）。

### 画像生成ツールに渡す指示文
```text
A square application icon for a Windows desktop app used to compare local AI model settings.
Motif: a party of three competing side by side, shown as three vertical rectangular bars of different heights.
Front view, centered, the three bars fill 72% of the square.
Flat symbol style with three solid shapes and slightly rounded corners, 4% of the width.
The tallest bar is in the middle and is the only accent-colored shape.
Colors: background #141516 filling the whole square, short bars #ECEDEE, tallest bar #C8F031.
No light, no shadow, no gradient, no texture.
Must stay readable at 32 pixels.
No text, no fine lines, no patterns, no existing logos or characters.
```

### 書き出し仕様
| ICN | 種類 | 大きさ・形式 | 切り抜き・透明 | 置き場所の例 |
|---|---|---|---|---|
| ICN-001 | アプリアイコン | .ico（256 / 64 / 48 / 32 / 24 / 16）と 512px PNG | 不透明の正方形（`--radius-lg` 相当の角丸） | `build/icon.ico`（electron-builder の既定） |
| ICN-002 | GitHub 共有画像 | 1280×640 PNG | 不透明。背景 #141516、左にアイコン、右に CP-198 の名前。代替は CP-199 | リポジトリの Social preview |

### 大きさごとの点検
画像は未生成のため、作りの指示からの判断。

| 大きさ | 結果 |
|---|---|
| 256px | 3本の高さと色の差が見える |
| 32px | 柱3本と色の差まで読める |
| 16px | 柱の高さの差だけ残る。形は棒グラフと区別しにくい（R-12） |

## このドキュメントで決まったこと
- [D-24, D-25, D-28](00_brief.md#決定事項ログ)

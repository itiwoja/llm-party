# ADR-013：音楽生成は acestep.cpp の CLI を生成のたびに起動する
- 状態：承認・実装済み（2026-11-07）／ 決定者：ユーザー（作者の Windows 版を使う・既定のモデル・長さ・時間切れなし）＋ Claude 判断（CLI で動かす点、実機で決めた起動引数）
- 影響する ID：FR-012, API-103〜107, TBL-018, D-71, D-78, R-20, R-21

## 状況
音楽モデルを DL しても保存するだけで使えない（D-71）。ADR-002 と同じく、Python なしの子プロセスで動かしたい。

## 決定
ACE-Step 1.5 の C++ 版 [acestep.cpp](https://github.com/ServeurpersoCom/acestep.cpp)（MIT）を使う。1 曲ごとに `ace-lm`（作詞と構成）→ `ace-synth`（音声）の順に起動し、常駐はさせない。リクエストは JSON ファイルで渡し、ace-lm が書いた `request0.json` を ace-synth に渡すと `request00.mp3` ができる。

実行ファイルの場所は `LLM_PARTY_ACE_DIR` → `<dataDir>/runtime/ace` の順に探す。今は作者のサイトの Windows 版（版 07abf07）を置いている。

## 実機で分かったこと（RTX 4060 Laptop 8GB、WSL から Windows 版を起動）
| 項目 | 結果 | 実装 |
|---|---|---|
| LM を Vulkan で動かす | 説明文が `1000 1000…` のように壊れ、bpm・長さも狂う。`--no-fa` でも直らない。CPU なら正常 | `--device CPU` を常に付ける |
| LM を CPU で動かす時間 | 20 秒の曲で 19 秒、60 秒で 49 秒、240 秒で 2 分 31 秒 | — |
| 合成を Vulkan で動かす | 同じシードの CPU の結果と波形の相関 0.9993。時間は CPU の約 1/3（31 秒・85 秒） | 既定のデバイスのまま |
| VAE の既定の分割（1024） | 8.6GB を要求して VRAM 不足 | `--vae-chunk 384`。240 秒の曲も 1 分 12 秒で完走 |
| VRAM 不足のときの終了コード | **0 のまま**音声ができない | 終了コードでなくファイルの有無で判定 |
| WSL 側のプロセスを kill | Windows 側の exe も止まる | 取り消しは SIGKILL |
| CUDA | cublas64_13.dll が無く `ggml-cuda.dll` を読めない | 使わない（R-21） |

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| ace-server を常駐 | 読み込みを省ける。ジョブの API が画像と同じ形 | WSL から Windows の exe を動かすと 127.0.0.1 に届かない。既定でも 1 工程ごとにモデルを入れ替えるので読み込みは省けない | 開発環境で動かない |
| ソースからビルド | 出どころが明確。Linux でも動く | この環境の GPU ビルドは未確認（sd-server の CUDA ビルドは失敗した） | ユーザーが Windows 版を選択。exe 段階で再検討（R-20） |
| Python 版の ACE-Step | 公式 | ADR-002 の「Python なし」に反する | — |
| ace-lm を省いて ace-synth だけ | LM の時間が要らない | 作詞と構成の指示が入らず、品質が下がる | — |

## 影響
- 常駐しないので、チャットや画像のモデルを読むときに音楽を止める処理は要らない。順番は `GenerationSlot` が守る。音楽を始める前に llama-server と sd-server を止める
- 画像と音楽が同時に走らないよう、`GenerationSlot.mediaBusy` を共有する
- `--models` はフォルダを渡す方式なので、部品は同じリポジトリ（同じフォルダ）に置く。使うモデルはファイル名で指定する
- 進捗の割合は出ない。工程（作詞と構成・生成）だけを画面に出す
- Windows 版は RAM を Windows 側で使うので、WSL の RAM（7GB）には縛られない
- 手動の読み込み（API-024）は枠を通らないので、画像・音楽の生成中は BUSY で断る

## 使っている版の sha256（07abf07、2026-11-07 に取得）
作者のサイトでは公開されていないので、取得時の値を控える（R-20）。

```
009ac2d8f8b39a75a4114951f86198ec97746cfc9f1ee1349345d63078772e89  ace-lm.exe
3cea88b5704fdb893d8e473856d93f79567f628ccf68f188eb902166b4e4200b  ace-synth.exe
94bed403dd00bb7db7e859bbfb1c4db0766eda02c870eda6dd325aef5e9cd5da  ggml-base.dll
8b2afc4d2ed6fe67424952b7cdffd3e24a80bb93553eaec14158556d49829549  ggml-cpu-alderlake.dll
d59b91fc76bf524985777d89515df8e29c7e1bb764d8ca48cecab559dc2f9c0d  ggml-cpu-cannonlake.dll
7553fd4218fa94f25682dbe16a50f6cac54227963cad89cb029fbdc05abb8af3  ggml-cpu-cascadelake.dll
d89a6804b1f180d05b1e4322c81c775ca14d8213e9a8834fcdf18dd07eb682ad  ggml-cpu-haswell.dll
551661482d4e8e6a044c9b5e6a9e211aece3d0b6fdaab0c332f46be1fddd762d  ggml-cpu-icelake.dll
5067cb64cf4d6d300ccfe7ba8536645bceea0fe67752357df91afed784cf99bc  ggml-cpu-sandybridge.dll
7e6f99246c4fe282c30a6288230ccd7d934bebb4c3e890f20e284c3a68e19d45  ggml-cpu-skylakex.dll
ec04ffb977aa786a99239f5a8bfb34482c45cd9ac47557fea67ffc2d1f9a828a  ggml-cpu-sse42.dll
977bddca01179b0cfe777da33b622d7e5a4b9d2c8881ca7bcc904891481336ea  ggml-cpu-x64.dll
6d138427fd8676a5ad8eba33d1001ae402a457e3a33bfd174590f6199878249a  ggml-cuda.dll
cd88ab17d7ab5d104a6e38f4feb06a8fd0eff3b8ff01ac41c859074de1dec9bd  ggml-vulkan.dll
34ef1d8b3f0dc891b85c397653a722af0ba844921d25a7721d5c81eb0f157b05  ggml.dll
```

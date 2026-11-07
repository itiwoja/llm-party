#!/usr/bin/env node
// ace-lm / ace-synth の代役。第1引数が lm か synth
// FAKE_ACE_MODE: ok / fail（0 以外で終わる）/ slow（終わらない）/ silent（終了コード 0 なのに出力なし。VRAM 不足の再現）
//   / lm-silent（lm だけ、終了コード 0 なのに request0.json なし）/ lm-empty（lm_mode inspire で歌詞が空の request0.json を返す）
import { readFileSync, writeFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
const mode = process.env.FAKE_ACE_MODE ?? "ok";
const request = args[args.indexOf("--request") + 1];
console.error(`args: ${tool} ${args.join(" ")}`);
if (mode === "fail") {
  console.error("error: failed");
  process.exit(1);
}
if (mode === "slow") setInterval(() => undefined, 1000);
else if (tool === "lm" && mode === "lm-silent") {
  // 何も書かずに終わる
} else if (tool === "lm") {
  const body = JSON.parse(readFileSync(request, "utf8"));
  if (!args.includes("--device") || args[args.indexOf("--device") + 1] !== "CPU") process.exit(2);
  // 実物と同じく標準エラーへ、行の途中で切れて届く形で出す
  process.stderr.write("[fill Batch0] seed=7:\r\nbpm:120\r\ncap");
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.stderr.write("tion: 夏の曲\r\n</think>\r\n\r\n# Lyric\r\n[Verse]\r\n");
  if (body.lm_mode === "inspire") {
    // 実機の下書き：音声コードなしで、LM が決めた情報と歌詞が入る
    writeFileSync(request.replace(/\.json$/, "0.json"), JSON.stringify({ ...body, lyrics: mode === "lm-empty" ? "" : "[Verse]\n下書きの歌詞", bpm: 120, keyscale: "C major", duration: 138 }));
  } else writeFileSync(request.replace(/\.json$/, "0.json"), JSON.stringify({ ...body, lyrics: body.lyrics || "[Verse]\nテスト", bpm: 120, keyscale: "C major", seed: body.seed === -1 ? 7 : body.seed, audio_codes: "1,2" }));
} else if (mode !== "silent") {
  if (!args.includes("--vae-chunk")) process.exit(3);
  writeFileSync(request.replace(/\.json$/, "0.mp3"), "ID3fake");
}

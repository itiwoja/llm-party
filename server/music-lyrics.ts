import type { ChatMessage } from "./agent/stream";

/** 歌う1行にかかる秒数の目安。曲の長さから行数を決める（FR-023） */
export const SECONDS_PER_LINE = 4;
/** 歌詞の生成の上限。思考を入れても 4,000 文字の歌詞が収まる量 */
export const LYRICS_MAX_TOKENS = 4096;
/** API-109 が受け取る歌詞の上限と同じ */
export const LYRICS_MAX_CHARS = 4000;
/** これより行が少ない曲は、構成を Verse と Chorus に絞る */
const SHORT_SONG_LINES = 8;

/** チャットのモデルへの作詞の依頼。テンプレートによって system を受け付けないので user 1通にする */
export function lyricsMessages({ prompt, duration }: { prompt: string; duration: number }): ChatMessage[] {
  const lines = Math.max(1, Math.round(duration / SECONDS_PER_LINE));
  return [{
    role: "user",
    content: [
      "あなたは作詞家です。次の曲の説明をもとに、実際に歌う歌詞を書いてください。",
      "",
      "# 曲の説明",
      prompt,
      "",
      "# 書き方",
      "- 説明と同じ言語で書く。日本語の説明なら、漢字・ひらがな・カタカナで書き、ローマ字は使わない",
      "- 説明に書かれた人名・地名・店名・出来事は、名前を変えずに歌詞に入れる。説明の情報はできるだけ多く使う",
      "- 説明の文をそのまま写さず、リズムのある短いフレーズに作り直す。1行は 8〜16 文字ほどにする",
      "- 説明にない人物や出来事を作らない。説明が短いときは、雰囲気に合う言葉だけを足す",
      "- 「かっこいい」「J-POP」など、曲の雰囲気・ジャンル・楽器・テンポの指示は歌詞の言葉にしない。歌詞の調子に反映する",
      `- 曲の長さは ${duration} 秒。歌う行はサビの繰り返しも含めて全部で ${lines} 行以内にする`,
      lines < SHORT_SONG_LINES ? "- 短い曲なので、構成は [Verse] と [Chorus] だけにする" : "- 行数に収まるように構成を決め、サビは [Chorus] にする",
      "- 区切りは次のタグだけを1行で書く：[Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Outro] [Instrumental Break]",
      "- [Intro] と [Instrumental Break] の下には何も書かない",
      "- 括弧で書く演出や楽器の指示は入れない",
      "- 出力は歌詞とタグだけにする。題名・前置き・解説・コードブロックは書かない",
    ].join("\n"),
  }];
}

const isTag = (line: string) => /^\s*\[[^\]]+\]\s*$/.test(line);

/** 歌詞欄に入れる形にする。頼んでも付いてくる前置き・見出し・装飾を落とし、API-109 の上限に収める */
export function cleanLyrics(text: string): string {
  const lines = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split(/\r?\n/)
    .map((line) => line.replaceAll("**", "").trimEnd())
    .filter((line) => !/^\s*(```|#)/.test(line));
  const start = lines.findIndex(isTag);
  const lyrics = (start > 0 ? lines.slice(start) : lines).join("\n").trim();
  if (lyrics.length <= LYRICS_MAX_CHARS) return lyrics;
  const clipped = lyrics.slice(0, LYRICS_MAX_CHARS);
  // 行の途中で切らず、中身のなくなったタグも残さない
  return clipped.slice(0, clipped.lastIndexOf("\n") + 1 || LYRICS_MAX_CHARS).trimEnd().replace(/\n\s*\[[^\]]+\]$/, "").trimEnd();
}

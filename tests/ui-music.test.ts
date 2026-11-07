import { beforeEach, describe, expect, it } from "vitest";
import { insertTag } from "../src/pages/music/insertTag";
import { draftFromTrack, lyricsForRequest, musicStore } from "../src/pages/music/store";
import { clampDuration, INSTRUMENTAL } from "../src/pages/music/types";

describe("FR-024 構成タグの挿入", () => {
  it("空の欄には1行で入れ、カーソルは次の行", () => {
    expect(insertTag("", 0, "Verse")).toEqual({ text: "[Verse]\n", cursor: 8 });
  });

  it("行頭では前で改行せず、続きを次の行へ送る", () => {
    expect(insertTag("abc", 0, "Chorus")).toEqual({ text: "[Chorus]\nabc", cursor: 9 });
    expect(insertTag("a\nbc", 2, "Intro")).toEqual({ text: "a\n[Intro]\nbc", cursor: 10 });
  });

  it("行の途中では前で改行し、続きは次の行へ", () => {
    expect(insertTag("abcd", 2, "Bridge")).toEqual({ text: "ab\n[Bridge]\ncd", cursor: 12 });
  });

  it("行末では前で改行し、すでにある改行をタグの終わりに使う", () => {
    expect(insertTag("ab\ncd", 2, "Outro")).toEqual({ text: "ab\n[Outro]\ncd", cursor: 11 });
    expect(insertTag("ab", 2, "Outro")).toEqual({ text: "ab\n[Outro]\n", cursor: 11 });
  });

  it("末尾に改行があるときは空行にタグを入れる", () => {
    expect(insertTag("ab\n", 3, "Pre-Chorus")).toEqual({ text: "ab\n[Pre-Chorus]\n", cursor: 16 });
  });

  it("範囲外のカーソルは端に寄せる", () => {
    expect(insertTag("ab", 99, "Intro").text).toBe("ab\n[Intro]\n");
  });
});

describe("D-81 編集中の内容とジョブの状態", () => {
  beforeEach(() => musicStore.reset());

  it("下書きの完了で歌詞が入り、他の内容は変わらない", () => {
    musicStore.setDraft({ prompt: "夜明け", duration: 90 });
    musicStore.start("draft");
    expect(musicStore.get()).toMatchObject({ job: "draft", phase: "drafting" });
    musicStore.apply({ job: "draft", status: "progress", phase: "drafting", reasoning: "考え中" });
    expect(musicStore.get().reasoning).toBe("考え中");
    expect(musicStore.apply({ job: "draft", status: "completed", lyrics: "[Verse]\nla" })).toBeNull();
    expect(musicStore.get()).toMatchObject({ job: null, prompt: "夜明け", duration: 90, lyrics: "[Verse]\nla", reasoning: "" });
  });

  it("曲の完了で編集中の内容が空に戻り、曲の id を返す", () => {
    musicStore.setDraft({ prompt: "夜明け", lyrics: "la", duration: 90, instrumental: true });
    musicStore.start("track");
    const before = musicStore.get().completedSeq;
    expect(musicStore.apply({ job: "track", status: "completed", trackId: "t1" })).toBe("t1");
    expect(musicStore.get()).toMatchObject({ job: null, prompt: "", lyrics: "", duration: 60, instrumental: false, completedSeq: before + 1 });
  });

  it("失敗と取消では内容が残り、失敗は文を出す", () => {
    musicStore.setDraft({ prompt: "夜明け", lyrics: "la" });
    musicStore.start("track");
    musicStore.apply({ job: "track", status: "failed", error: "x" });
    expect(musicStore.get()).toMatchObject({ job: null, prompt: "夜明け", lyrics: "la", error: "曲の生成に失敗しました。GPU を使う他のアプリを閉じてから試してください" });
    musicStore.start("draft");
    expect(musicStore.get().error).toBe("");
    musicStore.apply({ job: "draft", status: "failed", error: "x" });
    expect(musicStore.get().error).toBe("歌詞の下書きに失敗しました");
    musicStore.start("track");
    musicStore.apply({ job: "track", status: "cancelled" });
    expect(musicStore.get()).toMatchObject({ job: null, error: "", prompt: "夜明け", lyrics: "la" });
  });

  it("POST の失敗で実行中を戻す。BUSY は固定の文、評価の実行中はその文のまま", () => {
    musicStore.start("track");
    musicStore.startFailed("track", { code: "BUSY", message: "別のものが動いています" });
    expect(musicStore.get()).toMatchObject({ job: null, error: "別の生成が動いています" });
    musicStore.start("track");
    musicStore.startFailed("track", { code: "BUSY", message: "評価の実行中です" });
    expect(musicStore.get().error).toBe("評価の実行中です");
  });

  it("イベントが POST の応答より先に届いていたら、失敗で戻さない", () => {
    musicStore.start("track");
    musicStore.apply({ job: "track", status: "completed", trackId: "t1" });
    musicStore.startFailed("track", { message: "遅れた失敗" });
    expect(musicStore.get().job).toBeNull();
  });

  it("起動時の状態の復元：drafting は下書き、composing と rendering は曲。idle は何もしない", () => {
    musicStore.restore({ status: "drafting", reasoning: "r" });
    expect(musicStore.get()).toMatchObject({ job: "draft", phase: "drafting", reasoning: "r" });
    musicStore.reset();
    musicStore.restore({ status: "rendering" });
    expect(musicStore.get()).toMatchObject({ job: "track", phase: "rendering" });
    musicStore.reset();
    musicStore.restore({ status: "idle" });
    expect(musicStore.get().job).toBeNull();
  });
});

describe("FR-026 作り直しと生成の中身", () => {
  it("[Instrumental] の曲は歌なしに戻し、歌詞は空にする", () => {
    expect(draftFromTrack({ prompt: "p", lyrics: INSTRUMENTAL, duration: 30 })).toEqual({ prompt: "p", lyrics: "", duration: 30, instrumental: true });
    expect(draftFromTrack({ prompt: "p", lyrics: "[Verse]\nla", duration: 30 })).toEqual({ prompt: "p", lyrics: "[Verse]\nla", duration: 30, instrumental: false });
  });

  it("歌なしは [Instrumental]、歌詞が空なら送らない", () => {
    expect(lyricsForRequest({ lyrics: "la", instrumental: true })).toBe(INSTRUMENTAL);
    expect(lyricsForRequest({ lyrics: " \n", instrumental: false })).toBeUndefined();
    expect(lyricsForRequest({ lyrics: "la", instrumental: false })).toBe("la");
  });
});

describe("長さの収め方", () => {
  it.each([
    [5, 10], [10, 10], [59.6, 60], [240, 240], [999, 240], [0, 60], [Number.NaN, 60],
  ])("%s → %s", (input, expected) => {
    expect(clampDuration(input)).toBe(expected);
  });
});

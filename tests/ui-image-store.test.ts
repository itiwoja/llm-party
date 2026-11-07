import { beforeEach, describe, expect, it } from "vitest";
import { imageStore } from "../src/pages/threads/imageStore";

const job = { threadId: "t1", prompt: "人の画像", modelId: "m1" };
const idle = { step: null, totalSteps: null, previewSeq: 0 };

describe("D-84 画像生成の実行状態", () => {
  beforeEach(() => imageStore.reset());

  it("再読み込みの後は status から実行中へ戻す", () => {
    imageStore.restore({ status: "running", ...job }, imageStore.finishedSeq());
    expect(imageStore.get().job).toEqual(job);
  });

  it("問い合わせ中に終わったら、古い status で実行中へ戻さない", () => {
    const seq = imageStore.finishedSeq();
    imageStore.apply({ threadId: "t1", status: "completed" });
    imageStore.restore({ status: "running", ...job }, seq);
    expect(imageStore.get().job).toBeNull();
  });

  it("進捗では変わらず、失敗は依頼の文と一緒に残り、次の生成で消える", () => {
    imageStore.start(job);
    imageStore.apply({ threadId: "t1", status: "progress" });
    expect(imageStore.get().job).toEqual(job);

    imageStore.apply({ threadId: "t1", status: "failed", error: "VRAM 不足" });
    expect(imageStore.get()).toEqual({ job: null, progress: idle, failure: { threadId: "t1", prompt: "人の画像", error: "VRAM 不足" } });

    imageStore.start({ ...job, threadId: "t2" });
    expect(imageStore.get().failure).toBeNull();
  });

  it("ステップと途中の画像の番号を受け、再読み込みでも戻す（D-85）", () => {
    imageStore.start(job);
    imageStore.apply({ threadId: "t1", status: "progress", step: 3, totalSteps: 20, previewSeq: 3 });
    expect(imageStore.get().progress).toEqual({ step: 3, totalSteps: 20, previewSeq: 3 });

    imageStore.apply({ threadId: "other", status: "progress", step: 9, totalSteps: 20, previewSeq: 9 });
    expect(imageStore.get().progress.step).toBe(3);

    imageStore.reset();
    imageStore.restore({ status: "running", ...job, step: 7, totalSteps: 20, previewSeq: 7 }, imageStore.finishedSeq());
    expect(imageStore.get().progress).toEqual({ step: 7, totalSteps: 20, previewSeq: 7 });
  });

  it("止めたら実行中でなくなり、失敗にもならない", () => {
    imageStore.start(job);
    imageStore.apply({ threadId: "t1", status: "cancelled" });
    expect(imageStore.get()).toEqual({ job: null, progress: idle, failure: null });
  });
});

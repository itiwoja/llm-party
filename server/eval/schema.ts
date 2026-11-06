import path from "node:path";
import { z } from "zod";

/** FR-017 の採点方法 */
export const graderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("match"), mode: z.enum(["contains", "exact", "regex"]), expected: z.string(), ignoreCase: z.boolean().default(false) }),
  z.object({ type: z.literal("manual"), scale: z.enum(["pass_fail", "1to5"]), rubric: z.string().optional() }),
  z.object({ type: z.literal("test"), command: z.string().trim().min(1) }),
]);

/** FR-015 のケース。画面の保存と JSONL の1行で同じ検証を使う */
export const caseSchema = z
  .object({
    name: z.string().trim().min(1),
    kind: z.enum(["chat", "agent"]),
    input: z.string().refine((value) => value.trim() !== "", "空にできません"),
    fixture: z.string().nullish(),
    grader: graderSchema,
    tags: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "agent" && !value.fixture?.trim()) {
      ctx.addIssue({ code: "custom", path: ["fixture"], message: "agent のケースには fixture が必要です" });
    }
    if (value.fixture && (path.isAbsolute(value.fixture) || value.fixture.split(/[\\/]/).includes(".."))) {
      ctx.addIssue({ code: "custom", path: ["fixture"], message: "fixturesDir からの相対パスで指定します" });
    }
    // test は作業フォルダで動かすので、フォルダのある agent のケースだけ
    if (value.grader.type === "test" && value.kind !== "agent") {
      ctx.addIssue({ code: "custom", path: ["grader"], message: "test の採点は agent のケースだけです" });
    }
  });

export type Grader = z.infer<typeof graderSchema>;
export type CaseInput = z.infer<typeof caseSchema>;

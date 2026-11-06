import { z } from "zod";
import { ApiError } from "../http-error";

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(
    "VALIDATION_ERROR",
    "入力が正しくありません",
    result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  );
}

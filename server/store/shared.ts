export const now = () => new Date().toISOString();

export function isUniqueError(error: unknown): boolean {
  return (error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT_UNIQUE") ?? false;
}

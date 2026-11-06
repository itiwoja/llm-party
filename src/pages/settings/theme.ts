export type Theme = "system" | "light" | "dark";

/**
 * テーマを画面に反映する。tokens.css は data-theme が light / dark のときだけ固定し、
 * 無ければ OS に合わせる（prefers-color-scheme）。起動時は App が設定から呼ぶ
 */
export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

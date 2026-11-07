import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const isWindows = process.platform === "win32";

/**
 * 子プロセスごと止められる形で起動する spawn の指定。
 * Linux は自分のプロセスグループを持たせる。Windows の detached は別のコンソールを開くので使わず、taskkill /T で子孫まで止める
 */
export const treeSpawnOptions = { detached: !isWindows, windowsHide: true } as const;

/** 子孫ごと止める。もう居ないなら何もしない。Windows に穏やかな終了はないので、どちらのシグナルでも強制終了になる */
export function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** PID の実行ファイル名を含む文字列。居なければ null。PID の再利用を見分けるために使う */
export function processLabel(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindows) {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    return result.stdout?.includes(`"${pid}"`) ? result.stdout : null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

import * as Progress from "@radix-ui/react-progress";

interface Props {
  /** 0〜100。割合が不明なら null */
  value: number | null;
  /** 右に出す残り時間など（等幅） */
  detail?: string;
  /** 割合が不明なときに出す文字（「読み込み中」） */
  unknownLabel: string;
  label: string;
}

/** CMP-012 */
export function ProgressBar({ value, detail, unknownLabel, label }: Props) {
  if (value === null) return <p className="progress-unknown" role="status">{unknownLabel}</p>;
  return (
    <div className="progress">
      <Progress.Root className="progress-track" value={value} aria-label={label}>
        <Progress.Indicator className="progress-fill" style={{ width: `${value}%` }} />
      </Progress.Root>
      <span className="numeric progress-num">{Math.round(value)}%{detail ? `  ${detail}` : ""}</span>
    </div>
  );
}

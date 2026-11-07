import { SwitchField } from "../../components/Controls";
import { PG1 } from "./copy";

/** D-78 の長さ。サーバー（server/routes/music.ts）と同じ値 */
export const MUSIC_MIN_SECONDS = 10;
export const MUSIC_MAX_SECONDS = 240;
export const MUSIC_DEFAULT_SECONDS = 60;
export const INSTRUMENTAL = "[Instrumental]";

interface Props {
  duration: number;
  instrumental: boolean;
  lyrics: string;
  onDuration(value: number): void;
  onInstrumental(value: boolean): void;
  onLyrics(value: string): void;
}

/** 音楽モードのときだけ入力欄に足す欄。歌詞は空なら LM が作る */
export function MusicOptions({ duration, instrumental, lyrics, onDuration, onInstrumental, onLyrics }: Props) {
  /** 入力中の途中の値は通し、確定した値だけを範囲に収める */
  const clamp = () => onDuration(Math.min(MUSIC_MAX_SECONDS, Math.max(MUSIC_MIN_SECONDS, Math.round(duration) || MUSIC_DEFAULT_SECONDS)));
  return (
    <div className="music-options">
      <div className="music-options-row">
        <label className="field music-duration">
          <span className="field-label">{PG1.musicDuration}</span>
          <input
            className="input numeric"
            type="number"
            min={MUSIC_MIN_SECONDS}
            max={MUSIC_MAX_SECONDS}
            value={duration}
            onChange={(e) => onDuration(Number(e.target.value))}
            onBlur={clamp}
          />
        </label>
        <SwitchField label={PG1.musicInstrumental} checked={instrumental} onCheckedChange={onInstrumental} />
      </div>
      {instrumental ? null : (
        <label className="field">
          <span className="field-label">{PG1.musicLyrics}</span>
          <textarea
            className="input music-lyrics"
            rows={3}
            maxLength={4000}
            placeholder={PG1.musicLyricsPlaceholder}
            value={lyrics}
            onChange={(e) => onLyrics(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}

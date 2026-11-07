import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { PG10, PG10_MISSING } from "./copy";
import { insertTag } from "./insertTag";
import { LYRIC_TAGS } from "./types";

interface Props {
  value: string;
  onChange(value: string): void;
  /** 実行中。タグのボタンも入力欄も使えない */
  disabled: boolean;
  /** ラベルの右に置くボタン（AI に下書き） */
  action?: ReactNode;
}

/** CMP-023 歌詞エディタ。上にタグのボタン7つ、下に複数行の入力欄（FR-024） */
export function LyricsEditor({ value, onChange, disabled, action }: Props) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  /** 挿入のあとに戻すカーソル。値が描画されてから置く */
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pending.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(pending.current, pending.current);
    pending.current = null;
  }, [value]);

  function insert(tag: string) {
    const cursor = area.current?.selectionStart ?? value.length;
    const next = insertTag(value, cursor, tag);
    pending.current = next.cursor;
    onChange(next.text);
  }

  return (
    <div className="field music-lyrics-editor">
      <div className="music-lyrics-head">
        <label htmlFor={id} className="field-label">{PG10.lyrics}</label>
        {action}
      </div>
      <div className="music-tags" role="group" aria-label={PG10_MISSING.tags}>
        {LYRIC_TAGS.map((tag) => (
          <Button key={tag} variant="ghost" size="sm" disabled={disabled} aria-label={PG10.insertTag(tag)} onClick={() => insert(tag)}>
            {tag}
          </Button>
        ))}
      </div>
      <textarea
        ref={area}
        id={id}
        className="input music-lyrics"
        maxLength={4000}
        placeholder={PG10.lyricsPlaceholder}
        readOnly={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

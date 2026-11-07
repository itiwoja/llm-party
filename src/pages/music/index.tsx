import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "../../api";
import { useAppData } from "../../app-data";
import { Button } from "../../components/Button";
import { Collapsible } from "../../components/Collapsible";
import { SwitchField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { TextArea, TextField } from "../../components/Field";
import { ListRow } from "../../components/ListRow";
import { CP } from "../../copy";
import { ManageLayout } from "../../layouts";
import { hrefOf, navigate, useRoute } from "../../router";
import { PG10, PG10_MISSING } from "./copy";
import { LyricsEditor } from "./LyricsEditor";
import { draftFromTrack, hasDraftContent, lyricsForRequest, musicStore, useMusicState, type MusicState } from "./store";
import { clampDuration, INSTRUMENTAL, type TrackDetail, type TrackListItem } from "./types";
import { useTrackAudio } from "./useTrackAudio";
import "./music.css";

const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 実行中の文。LM の思考は折りたたみに入れる。進捗の割合は出さない */
function runningText(s: MusicState): string {
  if (s.job === "draft") return PG10.draftingLyrics;
  return s.phase === "rendering" ? PG10.composingPost : PG10.composingPre;
}

function RunStatus({ state }: { state: MusicState }) {
  return (
    <div className="music-status">
      <p className="status-shimmer" role="status">{runningText(state)}</p>
      {state.reasoning ? <Collapsible summary={CP.thinking}><div className="reasoning">{state.reasoning}</div></Collapsible> : null}
    </div>
  );
}

const firstLine = (text: string) => text.split("\n", 1)[0] ?? "";
const dateLabel = (value: string | number) => new Date(value).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** PG-010 音楽（管理の型）。左に曲の一覧、右にエディタか曲（SEC-010-01, 02） */
export function MusicPage() {
  const route = useRoute();
  const routeId = route.page === "music" ? route.id : undefined;
  const { models } = useAppData();
  const state = useMusicState();
  const musicModel = models.find((m) => m.use === "music");

  const [tracks, setTracks] = useState<TrackListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const loadingMore = useRef(false);
  const sentinel = useRef<HTMLLIElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  /** 先頭の1ページを読み直す。すでに読んだ続きは残す */
  const reload = useCallback(async () => {
    const page = await api.get<{ items: TrackListItem[]; nextCursor: string | null }>("/tracks");
    // 続きまで読んでいたら、続きのカーソルはそのまま使う
    if ((tracksRef.current?.length ?? 0) <= page.items.length) setNextCursor(page.nextCursor);
    setTracks((old) => [...page.items, ...(old ?? []).filter((t) => !page.items.some((n) => n.id === t.id))]);
  }, []);
  useEffect(() => { void reload().catch((err) => { setTracks([]); setListError(errorOf(err)); }); }, [reload, state.completedSeq]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const page = await api.get<{ items: TrackListItem[]; nextCursor: string | null }>(`/tracks?cursor=${encodeURIComponent(nextCursor)}`);
      setTracks((old) => [...(old ?? []), ...page.items.filter((n) => !(old ?? []).some((t) => t.id === n.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setListError(errorOf(err));
      setNextCursor(null);
    } finally {
      loadingMore.current = false;
    }
  }, [nextCursor]);

  // 一覧の末尾が見えたら次を読む
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !nextCursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore, tracks]);

  const list = (
    <>
      <Button onClick={() => navigate("/music")}>{PG10.newTrack}</Button>
      {tracks && tracks.length === 0 ? <p className="empty">{PG10.empty}</p> : null}
      {listError ? <p className="field-error" role="alert">{listError}</p> : null}
      <ul className="rows music-rows">
        {tracks === null ? [0, 1, 2].map((i) => <li key={i} className="row music-row-empty" aria-hidden />) : null}
        {tracks?.map((t) => (
          <ListRow
            key={t.id}
            title={firstLine(t.prompt)}
            href={hrefOf(`/music/${encodeURIComponent(t.id)}`)}
            selected={t.id === routeId}
            status={<span className="music-row-meta numeric">{PG10_MISSING.seconds(t.duration)} ・ {dateLabel(t.createdAt)}</span>}
          />
        ))}
        {nextCursor ? <li ref={sentinel} className="music-sentinel" aria-hidden /> : null}
      </ul>
    </>
  );

  return (
    <ManageLayout list={list}>
      <h1 className="sr-only">{CP.nav.music}</h1>
      {routeId ? (
        <TrackView
          key={routeId}
          id={routeId}
          state={state}
          onDeleted={() => { setTracks((old) => old?.filter((t) => t.id !== routeId) ?? old); navigate("/music"); }}
        />
      ) : (
        <Editor state={state} modelId={musicModel?.id ?? null} />
      )}
    </ManageLayout>
  );
}

/** POST の前に実行中にしておき、失敗したら戻す（イベントが応答より先に届いても壊れない） */
async function startJob(job: "draft" | "track", path: string, body: unknown): Promise<void> {
  musicStore.start(job);
  try {
    await api.post(path, body);
  } catch (err) {
    musicStore.startFailed(job, { code: err instanceof ApiRequestError ? err.code : undefined, message: errorOf(err) });
  }
}

/** サーバーが「動いていない」と答えたら（worker の再起動後など）、イベントは届かないので画面を止める */
async function stopJob(job: MusicState["job"]): Promise<void> {
  const { status } = await api.post<{ status: "cancelling" | "idle" }>("/music/cancel");
  if (status === "idle" && job) musicStore.apply({ job, status: "cancelled" });
}

function ConfirmOverwrite({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={PG10.overwriteTitle}
      footer={
        <>
          <Button onClick={onCancel}>{CP.cancel}</Button>
          <Button variant="primary" onClick={onConfirm}>{PG10.overwrite}</Button>
        </>
      }
    />
  );
}

function Editor({ state, modelId }: { state: MusicState; modelId: string | null }) {
  const running = state.job !== null;
  const [confirmDraft, setConfirmDraft] = useState(false);
  const canDraft = !running && !!modelId && state.prompt.trim() !== "";
  const canGenerate = canDraft;

  function draft() {
    if (!modelId) return;
    setConfirmDraft(false);
    void startJob("draft", "/music/draft", { modelId, prompt: state.prompt });
  }

  function generate() {
    if (!modelId) return;
    const duration = clampDuration(state.duration);
    musicStore.setDraft({ duration });
    const lyrics = lyricsForRequest(state);
    void startJob("track", "/music/generate", { modelId, prompt: state.prompt, duration, ...(lyrics === undefined ? {} : { lyrics }) });
  }

  return (
    <div className="music-editor">
      <TextArea
        label={PG10.prompt}
        rows={3}
        maxLength={2000}
        placeholder={PG10.promptPlaceholder}
        readOnly={running}
        value={state.prompt}
        onChange={(e) => musicStore.setDraft({ prompt: e.target.value })}
      />
      <div className="music-options-row">
        <TextField
          label={PG10.duration}
          type="number"
          className="music-duration"
          min={10}
          max={240}
          readOnly={running}
          value={state.duration}
          onChange={(e) => musicStore.setDraft({ duration: Number(e.target.value) })}
          onBlur={() => musicStore.setDraft({ duration: clampDuration(state.duration) })}
        />
        {/* 実行中はスイッチも使えない。fieldset の disabled でまとめて止める */}
        <fieldset className="music-switch" disabled={running}>
          <SwitchField label={PG10.instrumental} checked={state.instrumental} onCheckedChange={(instrumental) => musicStore.setDraft({ instrumental })} />
        </fieldset>
      </div>
      {state.instrumental ? null : (
        <LyricsEditor
          value={state.lyrics}
          onChange={(lyrics) => musicStore.setDraft({ lyrics })}
          disabled={running}
          action={
            <Button size="sm" disabled={!canDraft} onClick={() => (state.lyrics.trim() !== "" ? setConfirmDraft(true) : draft())}>{PG10.draft}</Button>
          }
        />
      )}
      {!modelId ? (
        <p className="empty">
          {PG10.noModel} <a href={hrefOf("/models")}>{CP.nav.models}</a>
        </p>
      ) : null}
      {state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
      <div className="music-actions">
        {running ? <RunStatus state={state} /> : <span />}
        {running ? (
          <Button variant="primary" onClick={() => void stopJob(state.job).catch(() => undefined)}>{PG10.stop}</Button>
        ) : (
          <Button variant="primary" disabled={!canGenerate} onClick={generate}>{PG10.generate}</Button>
        )}
      </div>
      {confirmDraft ? <ConfirmOverwrite onCancel={() => setConfirmDraft(false)} onConfirm={draft} /> : null}
    </div>
  );
}

function TrackView({ id, state, onDeleted }: { id: string; state: MusicState; onDeleted(): void }) {
  const running = state.job !== null;
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [error, setError] = useState("");
  const [confirmRemake, setConfirmRemake] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const audio = useTrackAudio(track ? id : null);

  useEffect(() => {
    let alive = true;
    api.get<TrackDetail>(`/tracks/${encodeURIComponent(id)}`).then(
      (t) => { if (alive) setTrack(t); },
      (err) => {
        if (!alive) return;
        // 存在しない曲は編集の画面へ
        if (err instanceof ApiRequestError && err.status === 404) navigate("/music", true);
        else setError(errorOf(err));
      },
    );
    return () => { alive = false; };
  }, [id]);

  function remake() {
    if (!track) return;
    setConfirmRemake(false);
    musicStore.setDraft(draftFromTrack(track));
    navigate("/music");
  }

  async function remove() {
    setDeleteError("");
    try {
      await api.delete(`/tracks/${encodeURIComponent(id)}`);
      setDeleting(false);
      onDeleted();
    } catch (err) {
      setDeleteError(errorOf(err));
    }
  }

  const facts = track ? [PG10_MISSING.seconds(track.duration), track.bpm ? PG10_MISSING.bpm(track.bpm) : null, track.keyscale, track.modelName].filter(Boolean).join(" ・ ") : "";
  return (
    <div className="music-track">
      {running ? (
        <div className="music-actions">
          <RunStatus state={state} />
          <Button onClick={() => void stopJob(state.job).catch(() => undefined)}>{PG10.stop}</Button>
        </div>
      ) : null}
      {/* 別の曲を見ている間に下書きや生成が失敗しても分かるように、エディタと同じ案内を出す */}
      {state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {track ? (
        <>
          <section className="field">
            <span className="field-label">{PG10.prompt}</span>
            <p className="music-text">{track.prompt}</p>
          </section>
          <p className="music-facts numeric">{facts}</p>
          {track.lyrics.trim() !== "" && track.lyrics.trim() !== INSTRUMENTAL ? (
            <section className="field">
              <span className="field-label">{PG10.lyrics}</span>
              <p className="music-text">{track.lyrics}</p>
            </section>
          ) : null}
          {track.reasoning ? <Collapsible summary={CP.thinking}><div className="reasoning">{track.reasoning}</div></Collapsible> : null}
          {audio.src ? (
            <audio controls src={audio.src} aria-label={track.prompt} className="music-player" />
          ) : audio.loading ? (
            <p className="empty">{PG10.loading}</p>
          ) : audio.failed || audio.notFound ? (
            <p className="empty">{PG10.loadFailed}</p>
          ) : null}
          <div className="music-actions music-track-actions">
            <Button
              disabled={running}
              onClick={() => (hasDraftContent(musicStore.get()) ? setConfirmRemake(true) : remake())}
            >
              {PG10.remake}
            </Button>
            <Button onClick={() => { setDeleteError(""); setDeleting(true); }}>{CP.delete}</Button>
          </div>
        </>
      ) : null}
      {confirmRemake ? <ConfirmOverwrite onCancel={() => setConfirmRemake(false)} onConfirm={remake} /> : null}
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(false); }}
          title={PG10.deleteTitle}
          description={PG10.deleteBody}
          footer={
            <>
              <Button onClick={() => setDeleting(false)}>{CP.cancel}</Button>
              <Button variant="danger" onClick={() => void remove()}>{CP.delete}</Button>
            </>
          }
        >
          {deleteError ? <p className="field-error" role="alert">{deleteError}</p> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

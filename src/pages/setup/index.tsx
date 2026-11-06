import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ServerEvent } from "../../api";
import { useAppData } from "../../app-data";
import { Button } from "../../components/Button";
import { ProgressBar } from "../../components/ProgressBar";
import { MISSING_COPY } from "../../copy";
import { StepLayout } from "../../layouts";
import { navigate } from "../../router";
import { pickFile, pickFolder } from "../../platform";
import { FREE_MARGIN_BYTES, errorMessage, formatBytes, formatEta } from "../models/format";
import { ErrorLine } from "../models/ErrorLine";
import { hfFailure } from "../models/HfTab";
import type { DownloadItem, HfFile, ModelItem } from "../models/types";
import { isActive } from "../models/types";
import { useDownloads } from "../models/useDownloads";
import { createRecommended } from "../presets/defaults";
import { QWEN_CHAT, QWEN_CODING } from "../presets/qwen";
import { PG2 } from "./copy";
import "./setup.css";

/** D-33 初回のおすすめ。unsloth/Qwen3.5-9B-GGUF の Qwen3.5-9B-Q4_K_M.gguf */
const REC_REPO = "unsloth/Qwen3.5-9B-GGUF";
const REC_FILE = "Qwen3.5-9B-Q4_K_M.gguf";
const REC_MODEL = "Qwen3.5-9B";

interface Settings { modelsDir: string; modelsFreeBytes: number; defaultContextSize: number }
type Listen = (listener: (event: ServerEvent) => void) => () => void;

/** DL を見ているもの。ページを離れても完了まで残す（「次へ」は DL 中も押せるため） */
const watched = new Set<string>();
/** 既定プリセットを作った（作っている）DL。完了の通知とページを開いたときの確認で二重に作らない */
const handled = new Set<string>();

/** 完了したらおすすめの既定プリセット 2 つを作る（D-28, FR-014）。ページが無くなっても動くよう、購読はページの外に持つ */
function watchRecommended(listen: Listen, downloadId: string, afterCreate: () => Promise<void>, onError: (err: unknown) => void): void {
  if (watched.has(downloadId)) return;
  watched.add(downloadId);
  const off = listen((event) => {
    if (event.event !== "download.progress" || event.data.downloadId !== downloadId) return;
    const { status } = event.data as { status: string };
    if (status === "failed" || status === "cancelled") {
      off();
      watched.delete(downloadId);
    } else if (status === "completed") {
      off();
      watched.delete(downloadId);
      void ensureDefaults(downloadId).then(afterCreate).catch(onError);
    }
  });
}

async function ensureDefaults(downloadId: string): Promise<void> {
  if (handled.has(downloadId)) return;
  handled.add(downloadId);
  try {
    await createDefaults(downloadId);
  } catch (err) {
    handled.delete(downloadId);
    throw err;
  }
}

async function createDefaults(downloadId: string): Promise<void> {
  const [downloads, models, settings] = await Promise.all([
    api.get<{ items: DownloadItem[] }>("/downloads"),
    api.get<{ items: ModelItem[] }>("/models"),
    api.get<Settings>("/settings"),
  ]);
  const modelId = downloads.items.find((d) => d.id === downloadId)?.resultId;
  const model = models.items.find((m) => m.id === modelId);
  if (!model) return;
  await createRecommended(model, QWEN_CODING, settings.defaultContextSize);
  await createRecommended(model, QWEN_CHAT, settings.defaultContextSize);
}

/**
 * PG-002 初回セットアップ（手順の型）。localhost 段階は GPU の手順（1/3）を飛ばし、2/3 から始める（12）。
 * 手順の番号は 05 のワイヤーどおり 2/3、3/3 のまま
 */
export function SetupPage() {
  const { reloadModels, reloadPresets, listen } = useAppData();
  const [step, setStep] = useState<2 | 3>(2);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [file, setFile] = useState<HfFile | null>(null);
  const [fileFailure, setFileFailure] = useState<unknown>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<"download" | "local" | null>(null);
  const downloads = useDownloads();

  const loadSettings = useCallback(async () => setSettings(await api.get<Settings>("/settings")), []);
  useEffect(() => { void loadSettings().catch(setFailure); }, [loadSettings]);

  useEffect(() => {
    api.get<{ items: HfFile[] }>(`/hf/files?repo=${encodeURIComponent(REC_REPO)}`)
      .then((res) => setFile(res.items.find((f) => f.name === REC_FILE) ?? null))
      .catch(setFileFailure);
  }, []);

  const afterCreate = useCallback(async () => {
    await Promise.all([reloadModels(), reloadPresets()]);
  }, [reloadModels, reloadPresets]);

  // 取り消し済みでない最新のおすすめの DL
  const current = useMemo(
    () => downloads.items.find((d) => d.repo === REC_REPO && d.kind === "model" && d.status !== "cancelled"),
    [downloads.items],
  );
  // ページを開き直したときも、動いている DL の完了を見張る
  useEffect(() => {
    if (!current) return;
    if (isActive(current.status)) watchRecommended(listen, current.id, afterCreate, setFailure);
    // ページを閉じている間に終わっていたら、ここで作る（同じ名前があれば作らない）
    else if (current.status === "completed") void ensureDefaults(current.id).then(afterCreate).catch(setFailure);
  }, [current, listen, afterCreate]);

  const need = file ? file.sizeBytes + FREE_MARGIN_BYTES : null;
  const noSpace = need !== null && settings !== null && settings.modelsFreeBytes < need;

  async function changePlace() {
    setFailure(null);
    const dir = await pickFolder();
    if (!dir) return;
    try {
      await api.patch("/settings", { modelsDir: dir });
      await loadSettings();
    } catch (err) {
      setFailure(err);
    }
  }

  async function startDownload() {
    if (!file) return;
    setFailure(null);
    setBusy("download");
    try {
      const record = await api<DownloadItem>("/downloads", { repo: REC_REPO, files: [file.name], kind: "model" });
      watchRecommended(listen, record.id, afterCreate, setFailure);
      await downloads.reload();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  }

  async function useLocalFile() {
    setFailure(null);
    const path = await pickFile();
    if (!path) return;
    setBusy("local");
    try {
      const model = await api<ModelItem>("/models", { path, mode: "reference" });
      await createRecommended(model, QWEN_CHAT, settings?.defaultContextSize ?? 32768, model.name);
      await afterCreate();
      setStep(3);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  }

  async function act(action: "cancel" | "resume") {
    if (!current) return;
    setFailure(null);
    try {
      await api.post(`/downloads/${current.id}/${action}`);
      if (action === "resume") watchRecommended(listen, current.id, afterCreate, setFailure);
      await downloads.reload();
    } catch (err) {
      setFailure(err);
    }
  }

  if (step === 3) {
    return (
      <StepLayout>
        <div className="setup">
          <p className="setup-no numeric">3/3</p>
          <h1>{PG2.commHeading}</h1>
          <p className="setup-text">{PG2.commBody}</p>
          <div className="setup-actions">
            <Button variant="primary" onClick={() => navigate("/threads")}>{PG2.start}</Button>
          </div>
        </div>
      </StepLayout>
    );
  }

  let progress: ReactNode = null;
  if (current) {
    const eta = downloads.etaSeconds(current);
    progress = (
      <div className="setup-dl">
        <p className="setup-note">{PG2.status[current.status]}</p>
        {current.status === "downloading" && current.totalBytes ? (
          <ProgressBar value={(current.receivedBytes / current.totalBytes) * 100} detail={eta === null ? undefined : formatEta(eta)} unknownLabel={MISSING_COPY.engineStarting} label={PG2.heading} />
        ) : null}
        {current.status === "failed" && current.error ? <ErrorLine message={current.error} /> : null}
      </div>
    );
  }

  return (
    <StepLayout>
      <div className="setup">
        <p className="setup-no numeric">2/3</p>
        <h1>{PG2.heading}</h1>
        {file ? <p className="setup-text">{PG2.recommended(`${REC_MODEL} ${file.quantization ?? ""}`.trim(), formatBytes(file.sizeBytes))}</p> : null}
        {settings ? (
          <>
            <div className="setup-row">
              <span className="field-label">{PG2.place}</span>
              <p className="setup-path">{settings.modelsDir}</p>
              <Button size="sm" onClick={() => void changePlace()}>{PG2.change}</Button>
            </div>
            <p className="setup-note">{PG2.free(formatBytes(settings.modelsFreeBytes))}</p>
          </>
        ) : null}
        {progress}
        {noSpace && !current ? <ErrorLine message={PG2.noSpace(formatBytes(need!))} /> : null}
        {fileFailure ? hfFailure(fileFailure) : null}
        {failure ? hfFailure(failure) : null}
        <div className="setup-actions">
          {current ? (
            <>
              <Button variant="primary" onClick={() => setStep(3)}>{PG2.next}</Button>
              {current.status === "failed" ? <Button onClick={() => void act("resume")}>{PG2.resume}</Button> : null}
              {isActive(current.status) || current.status === "failed" ? <Button onClick={() => void act("cancel")}>{PG2.cancelDownload}</Button> : null}
            </>
          ) : (
            <>
              <Button variant="primary" loading={busy === "download"} disabled={!file || noSpace || busy !== null} onClick={() => void startDownload()}>{PG2.download}</Button>
              <Button loading={busy === "local"} disabled={busy !== null} onClick={() => void useLocalFile()}>{PG2.useLocalFile}</Button>
              <Button variant="ghost" onClick={() => setStep(3)}>{PG2.later}</Button>
            </>
          )}
        </div>
      </div>
    </StepLayout>
  );
}

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useAppData } from "../../app-data";
import { Tabs } from "../../components/Tabs";
import { ManageLayout } from "../../layouts";
import { CP } from "../../copy";
import { PG3 } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage } from "./format";
import { HfTab } from "./HfTab";
import { LocalTab } from "./LocalTab";
import type { AdapterItem, ModelItem } from "./types";
import { useDownloads } from "./useDownloads";
import "./models.css";

/** PG-003 モデル（管理の型）。タブ：手元のモデル（DL の行を含む） / LoRA / Hugging Face を探す */
export function ModelsPage() {
  const { reloadModels } = useAppData();
  const [tab, setTab] = useState("models");
  const [models, setModels] = useState<ModelItem[]>([]);
  const [adapters, setAdapters] = useState<AdapterItem[]>([]);
  const [loadError, setLoadError] = useState("");
  const downloads = useDownloads();

  const load = useCallback(async () => {
    const data = await api.get<{ items: ModelItem[]; adapters: AdapterItem[] }>("/models");
    setModels(data.items);
    setAdapters(data.adapters);
  }, []);
  const loadSafely = useCallback(() => load().then(() => setLoadError(""), (err) => setLoadError(errorMessage(err))), [load]);
  useEffect(() => { void loadSafely(); }, [loadSafely]);

  // DL が終わるとサーバーがモデルを登録するので、一覧を読み直す
  const completed = downloads.items.filter((d) => d.status === "completed").length;
  useEffect(() => { void loadSafely(); }, [completed, loadSafely]);

  // useAppData のモデルも読み直す（プリセット・アイコン列の 0 件判定が使う）
  const reloadDownloads = downloads.reload;
  const changed = useCallback(() => {
    void loadSafely();
    void reloadModels().catch((err) => setLoadError(errorMessage(err)));
    void reloadDownloads();
  }, [loadSafely, reloadModels, reloadDownloads]);

  return (
    <ManageLayout>
      <div className="models-main">
        <h1 className="sr-only">{CP.nav.models}</h1>
        {loadError || downloads.error ? <ErrorLine message={loadError || downloads.error} /> : null}
        <Tabs
          ariaLabel={CP.nav.models}
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "models", label: PG3.tabModels, content: <LocalTab kind="model" models={models} adapters={adapters} downloads={downloads.items} etaSeconds={downloads.etaSeconds} onChanged={changed} /> },
            { value: "adapters", label: PG3.tabAdapters, content: <LocalTab kind="adapter" models={models} adapters={adapters} downloads={downloads.items} etaSeconds={downloads.etaSeconds} onChanged={changed} /> },
            { value: "hf", label: PG3.tabHf, content: <HfTab onStarted={() => { changed(); setTab("models"); }} /> },
          ]}
        />
      </div>
    </ManageLayout>
  );
}

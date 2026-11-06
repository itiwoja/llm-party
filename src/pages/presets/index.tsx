import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useAppData } from "../../app-data";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { ListRow } from "../../components/ListRow";
import { CP, MISSING_COPY } from "../../copy";
import { ManageLayout } from "../../layouts";
import { hrefOf, navigate, useRoute } from "../../router";
import type { AdapterItem, ModelItem } from "../models/types";
import { PG4 } from "./copy";
import { newValues, PresetForm, valuesOf, type FormValues, type PresetFull } from "./PresetForm";
import "./presets.css";

/** PG-004 プリセット（管理の型）。左に一覧、右に編集（SEC-004-01, 002） */
export function PresetsPage() {
  const route = useRoute();
  const routeId = route.page === "presets" ? route.id : undefined;
  const { reloadPresets } = useAppData();
  const [presets, setPresets] = useState<PresetFull[] | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [adapters, setAdapters] = useState<AdapterItem[]>([]);
  const [defaultContextSize, setDefaultContextSize] = useState(32768);
  /** 複製で作った下書き。名前だけ空にして新規の形で開く */
  const [seed, setSeed] = useState<{ key: number; values: FormValues } | null>(null);
  const [deleting, setDeleting] = useState<PresetFull | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const [list, modelData, settings] = await Promise.all([
      api.get<{ items: PresetFull[] }>("/presets"),
      api.get<{ items: ModelItem[]; adapters: AdapterItem[] }>("/models"),
      api.get<{ defaultContextSize: number }>("/settings"),
    ]);
    setPresets(list.items);
    setModels(modelData.items);
    setAdapters(modelData.adapters);
    setDefaultContextSize(settings.defaultContextSize);
  }, []);
  useEffect(() => { void load().catch((err) => { setPresets([]); setLoadError(err instanceof Error ? err.message : String(err)); }); }, [load]);

  const selected = presets?.find((p) => p.id === routeId) ?? null;
  const creating = routeId === "new";

  // id が無い・見つからないときは先頭を開く。1 件も無ければ新規の形
  useEffect(() => {
    if (!presets || creating || selected) return;
    navigate(presets[0] ? `/presets/${presets[0].id}` : "/presets/new", true);
  }, [presets, creating, selected]);

  async function refresh() {
    await load();
    await reloadPresets();
  }

  function duplicate(preset: PresetFull) {
    setSeed({ key: Date.now(), values: { ...valuesOf(preset), name: "" } });
    navigate("/presets/new");
  }

  async function remove(preset: PresetFull) {
    setDeleteError("");
    try {
      await api.delete(`/presets/${preset.id}`);
      setDeleting(null);
      // 開いていたものを消したら、残りの先頭へ移る（読み直しを待たずに移り、遅れて戻されないようにする）
      // 待っている間に別のページへ移っていたら戻さない
      if (location.hash === hrefOf(`/presets/${preset.id}`)) {
        const next = presets?.find((p) => p.id !== preset.id);
        navigate(next ? `/presets/${next.id}` : "/presets/new", true);
      }
      await refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  }

  const list = (
    <>
      <Button onClick={() => { setSeed(null); navigate("/presets/new"); }}>{PG4.newPreset}</Button>
      {presets && presets.length === 0 ? <p className="empty">{PG4.empty}</p> : null}
      <ul className="rows">
        {presets?.map((p) => (
          <ListRow
            key={p.id}
            title={p.name}
            href={hrefOf(`/presets/${p.id}`)}
            selected={p.id === routeId}
            menuLabel={MISSING_COPY.rowMenu}
            menu={[
              { label: PG4.duplicate, onSelect: () => duplicate(p) },
              { label: CP.delete, danger: true, onSelect: () => { setDeleteError(""); setDeleting(p); } },
            ]}
          />
        ))}
      </ul>
    </>
  );

  const ready = presets !== null && models.length > 0 && (creating || selected);
  return (
    <ManageLayout list={list}>
      <h1 className="sr-only">{CP.nav.presets}</h1>
      {loadError ? <p className="field-error" role="alert">{loadError}</p> : null}
      {ready ? (
        <PresetForm
          key={creating ? `new-${seed?.key ?? 0}` : selected!.id}
          preset={creating ? null : selected}
          initial={creating ? seed?.values ?? newValues(models, defaultContextSize) : valuesOf(selected!)}
          models={models}
          adapters={adapters}
          onSaved={(saved) => { setSeed(null); void refresh().then(() => { if (location.hash === hrefOf(`/presets/${routeId}`)) navigate(`/presets/${saved.id}`, true); }, (err) => setLoadError(err instanceof Error ? err.message : String(err))); }}
        />
      ) : null}
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(null); }}
          title={PG4.confirmDelete(deleting.name)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{CP.cancel}</Button>
              <Button variant="danger" onClick={() => void remove(deleting)}>{CP.delete}</Button>
            </>
          }
        >
          {deleteError ? <p className="field-error" role="alert">{deleteError}</p> : null}
        </Dialog>
      ) : null}
    </ManageLayout>
  );
}

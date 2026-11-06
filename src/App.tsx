import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "./api";
import { AppDataProvider, useAppData } from "./app-data";
import { Button } from "./components/Button";
import { Dialog } from "./components/Dialog";
import { TextField } from "./components/Field";
import { Rail } from "./components/Rail";
import { StatusBand } from "./components/StatusBand";
import { ToastProvider } from "./components/Toast";
import { TooltipProvider } from "./components/Tooltip";
import { CP } from "./copy";
import { ComparePage } from "./pages/compare";
import { EvalsPage } from "./pages/evals";
import { ModelsPage } from "./pages/models";
import { PresetsPage } from "./pages/presets";
import { RunsPage } from "./pages/runs";
import { SettingsPage } from "./pages/settings";
import { applyTheme, type Theme } from "./pages/settings/theme";
import { SetupPage } from "./pages/setup";
import { ThreadsPage } from "./pages/threads";
import { getConnection, setToken } from "./platform";
import { PathPromptHost } from "./platform/PathPromptHost";
import { navigate, useRoute, type Route } from "./router";

/** CP-204, CP-205。localhost 段階だけの接続の入力ダイアログ */
function TokenDialog({ onDone }: { onDone(): void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog open onOpenChange={() => undefined} dismissible={false} title={CP.tokenTitle}>
      <form
        className="dialog-form"
        onSubmit={(e) => { e.preventDefault(); setToken(value.trim()); onDone(); }}
      >
        <TextField label={CP.tokenHint} value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} autoComplete="off" />
        <div className="dialog-footer">
          <Button type="submit" variant="primary" disabled={!value.trim()}>{CP.decide}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "threads": return <ThreadsPage />;
    case "setup": return <SetupPage />;
    case "models": return <ModelsPage />;
    case "presets": return <PresetsPage />;
    case "evals": return <EvalsPage />;
    case "runs": return <RunsPage />;
    case "compare": return <ComparePage />;
    case "settings": return <SettingsPage />;
  }
}

/** 骨組み：状態の帯（上端・全幅）＋アイコン列＋ページ。手順の型（PG-002）はアイコン列を出さない */
function Shell() {
  const route = useRoute();
  const { models, modelsLoaded, band } = useAppData();

  // 起動時にモデル 0 件なら PG-002 へ（01_ia）。読み込み前に飛ばさないよう、一度届いてから1回だけ判定する。
  // 毎回判定すると、DL 中に「使い始める」を押しても PG-002 へ戻され続ける
  const checkedSetup = useRef(false);
  useEffect(() => {
    if (!modelsLoaded || checkedSetup.current) return;
    checkedSetup.current = true;
    if (models.length === 0 && route.page !== "setup") navigate("/setup", true);
  }, [modelsLoaded, models.length, route.page]);

  useEffect(() => {
    void api<{ theme: Theme }>("/settings").then(({ theme }) => applyTheme(theme)).catch(() => undefined);
  }, []);

  if (!modelsLoaded) return null;
  return (
    <div className="shell">
      <StatusBand item={band} />
      <div className="shell-body">
        {route.page === "setup" ? null : <Rail />}
        <Page route={route} />
      </div>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "ok" | "needed">("checking");
  const [connectError, setConnectError] = useState("");

  const check = useCallback(async () => {
    if (!getConnection().token) return setAuth("needed");
    try {
      await api("/health");
      setConnectError("");
      setAuth("ok");
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) setAuth("needed");
      else setConnectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  return (
    <TooltipProvider>
      <ToastProvider>
        {connectError ? <StatusBand item={{ kind: "error", message: connectError, action: <Button size="sm" onClick={() => void check()}>{CP.retry}</Button> }} /> : null}
        {auth === "needed" ? <TokenDialog onDone={() => void check()} /> : null}
        {auth === "ok" ? (
          <AppDataProvider onUnauthorized={() => setAuth("needed")}>
            <Shell />
            <PathPromptHost />
          </AppDataProvider>
        ) : null}
      </ToastProvider>
    </TooltipProvider>
  );
}

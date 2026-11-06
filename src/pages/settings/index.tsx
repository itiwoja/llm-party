import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { RadioField, SwitchField } from "../../components/Controls";
import { TextField } from "../../components/Field";
import { CP } from "../../copy";
import { ManageLayout } from "../../layouts";
import { pickFile, pickFolder } from "../../platform";
import { ErrorLine } from "../models/ErrorLine";
import { errorMessage, formatBytes } from "../models/format";
import { PG8 } from "./copy";
import { applyTheme, type Theme } from "./theme";
import "./settings.css";

interface Settings { modelsDir: string; modelsFreeBytes: number; backend: string; defaultAutoApprove: boolean; defaultContextSize: number; theme: Theme }
interface LocalInfo { version: string; llamaBuild: string | null; dataDir: string; logsDir: string }

const SECTIONS = [
  { id: "run", title: PG8.groupRun },
  { id: "connect", title: PG8.groupConnect },
  { id: "display", title: PG8.groupDisplay },
  { id: "diag", title: PG8.groupDiag },
] as const;

/** PG-008 設定（管理の型）。変更は即時保存。成功は項目の下に出す（CP-019） */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [contextInput, setContextInput] = useState("");
  /** 項目ごとの保存結果。key は項目名 */
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exported, setExported] = useState("");
  const [copied, setCopied] = useState(false);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  const mark = (key: string, error?: unknown) => {
    setSaved((s) => ({ ...s, [key]: !error }));
    setErrors((e) => ({ ...e, [key]: error ? errorMessage(error) : "" }));
  };

  useEffect(() => {
    void (async () => {
      const [s, i, t] = await Promise.all([
        api.get<Settings>("/settings"),
        api.get<LocalInfo>("/local/info"),
        api.get<{ has: boolean }>("/local/hf-token"),
      ]);
      setSettings(s);
      setContextInput(String(s.defaultContextSize));
      setInfo(i);
      setHasToken(t.has);
      applyTheme(s.theme);
    })().catch((err) => setErrors((e) => ({ ...e, load: errorMessage(err) })));
  }, []);

  const patch = useCallback(async (key: string, body: Partial<Settings>) => {
    try {
      const next = await api.patch<Settings>("/settings", body);
      setSettings(next);
      mark(key);
      return next;
    } catch (err) {
      mark(key, err);
      return null;
    }
  }, []);

  async function changeModelsDir() {
    const dir = await pickFolder();
    if (dir) await patch("modelsDir", { modelsDir: dir });
  }

  async function changeTheme(theme: string) {
    const next = await patch("theme", { theme: theme as Theme });
    if (next) applyTheme(next.theme);
  }

  async function commitContext() {
    if (!settings) return;
    const value = Number(contextInput);
    if (value === settings.defaultContextSize) return;
    const next = await patch("context", { defaultContextSize: value });
    if (!next) return;
    setContextInput(String(next.defaultContextSize));
  }

  async function saveToken(token: string | null) {
    try {
      const res = await api.put<{ has: boolean }>("/local/hf-token", { token });
      setHasToken(res.has);
      setTokenInput("");
      mark("token");
    } catch (err) {
      mark("token", err);
    }
  }

  async function exportDiagnostics() {
    const path = await pickFile();
    if (!path) return;
    try {
      const res = await api<{ path: string }>("/diagnostics/export", { path });
      setExported(res.path);
      mark("export");
    } catch (err) {
      setExported("");
      mark("export", err);
    }
  }

  async function copyLogsPath() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.logsDir);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      mark("logs", err);
    }
  }

  const nav = (
    <nav className="settings-nav" aria-label={CP.nav.settings}>
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" onClick={() => refs.current[s.id]?.scrollIntoView({ block: "start" })}>{s.title}</button>
      ))}
    </nav>
  );

  const section = (id: (typeof SECTIONS)[number]["id"], title: string, body: React.ReactNode) => (
    <section className="settings-group" ref={(el) => { refs.current[id] = el; }} aria-labelledby={`settings-${id}`}>
      <h2 id={`settings-${id}`}>{title}</h2>
      {body}
    </section>
  );

  const ok = (key: string) => (saved[key] && !errors[key] ? <p className="settings-ok">{CP.saved}</p> : null);
  const fail = (key: string) => (errors[key] ? <ErrorLine message={errors[key]} /> : null);

  return (
    <ManageLayout list={nav}>
      <h1 className="sr-only">{CP.nav.settings}</h1>
      {errors.load ? <ErrorLine message={errors.load} /> : null}
      {settings ? (
        <div className="settings-main">
          {section("run", PG8.groupRun, (
            <>
              <div className="settings-item">
                <span className="field-label">{PG8.modelsDir}</span>
                <div className="settings-row">
                  <p className="settings-value">{settings.modelsDir}</p>
                  <Button onClick={() => void changeModelsDir()}>{PG8.change}</Button>
                </div>
                <p className="settings-note">{PG8.free(formatBytes(settings.modelsFreeBytes))}</p>
                <p className="settings-note">{PG8.modelsDirNote}</p>
                {ok("modelsDir")}
                {fail("modelsDir")}
              </div>
              <div className="settings-item">
                <span className="field-label">{PG8.backend}</span>
                <p className="settings-value">{PG8.backendValue[settings.backend] ?? settings.backend}</p>
              </div>
              <TextField
                label={PG8.defaultContext}
                type="number"
                min={1}
                step={1}
                value={contextInput}
                onChange={(e) => { setContextInput(e.target.value); setSaved((s) => ({ ...s, context: false })); }}
                onBlur={() => void commitContext()}
                onKeyDown={(e) => { if (e.key === "Enter") void commitContext(); }}
                hint={saved.context ? CP.saved : undefined}
                error={errors.context || undefined}
              />
            </>
          ))}
          {section("connect", PG8.groupConnect, (
            <div className="settings-item">
              <div className="settings-inline">
                <TextField
                  label={PG8.hfToken}
                  type="password"
                  value={tokenInput}
                  onChange={(e) => { setTokenInput(e.target.value); setSaved((s) => ({ ...s, token: false })); }}
                  placeholder={hasToken ? "••••••••" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  hint={PG8.hfTokenNote}
                />
                <Button disabled={!tokenInput.trim()} onClick={() => void saveToken(tokenInput.trim())}>{CP.save}</Button>
                <Button disabled={!hasToken} onClick={() => void saveToken(null)}>{CP.delete}</Button>
              </div>
              {ok("token")}
              {fail("token")}
            </div>
          ))}
          {section("display", PG8.groupDisplay, (
            <>
              <div className="settings-item">
                <span className="field-label">{PG8.theme}</span>
                <RadioField
                  label={PG8.theme}
                  value={settings.theme}
                  onValueChange={(v) => void changeTheme(v)}
                  options={[
                    { value: "system", label: PG8.themeValue.system },
                    { value: "light", label: PG8.themeValue.light },
                    { value: "dark", label: PG8.themeValue.dark },
                  ]}
                />
                {ok("theme")}
                {fail("theme")}
              </div>
              <div className="settings-item">
                <SwitchField label={PG8.autoApprove} checked={settings.defaultAutoApprove} onCheckedChange={(v) => void patch("autoApprove", { defaultAutoApprove: v })} />
                {ok("autoApprove")}
                {fail("autoApprove")}
              </div>
            </>
          ))}
          {section("diag", PG8.groupDiag, (
            <>
              <div className="settings-item">
                <div>
                  <Button onClick={() => void exportDiagnostics()}>{PG8.exportDiag}</Button>
                </div>
                <p className="settings-note">{PG8.exportNote}</p>
                {exported ? <p className="settings-value">{exported}</p> : null}
                {fail("export")}
              </div>
              {info ? (
                <>
                  <p className="settings-value">{PG8.about(info.version, info.llamaBuild)}</p>
                  <div className="settings-item">
                    <div className="settings-row">
                      <p className="settings-value">{info.logsDir}</p>
                      <Button icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />} onClick={() => void copyLogsPath()}>{PG8.copyPath}</Button>
                    </div>
                    {fail("logs")}
                  </div>
                </>
              ) : null}
            </>
          ))}
        </div>
      ) : null}
    </ManageLayout>
  );
}

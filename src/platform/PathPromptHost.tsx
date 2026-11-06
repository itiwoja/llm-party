import { useState, useSyncExternalStore } from "react";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { TextField } from "../components/Field";
import { CP } from "../copy";
import { pathPromptStore } from "./pathPrompt";

/** App の根に1つ置く。pickFolder / pickFile を呼ぶとここがダイアログを出す（CP-200〜203） */
export function PathPromptHost() {
  const request = useSyncExternalStore(pathPromptStore.subscribe, pathPromptStore.get);
  return request ? <PathDialog key={request.id} kind={request.kind} /> : null;
}

function PathDialog({ kind }: { kind: "folder" | "file" }) {
  const [value, setValue] = useState("");
  const title = kind === "folder" ? CP.pickFolderTitle : CP.pickFileTitle;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) pathPromptStore.settle(null); }} title={title}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) pathPromptStore.settle(value.trim());
        }}
      >
        <TextField label={CP.pathHint} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "folder" ? "/home/…/project" : "/home/…/model.gguf"} autoFocus spellCheck={false} />
        <div className="dialog-footer">
          <Button onClick={() => pathPromptStore.settle(null)}>{CP.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>{CP.decide}</Button>
        </div>
      </form>
    </Dialog>
  );
}

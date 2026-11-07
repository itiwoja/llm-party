import { memoryNeed } from "../../server/hf/memory";
import { MISSING_COPY } from "../copy";

export const GPU_RATIO_STEP = 10;

/** プリセットのバーの下に出す、そのモデルの VRAM・RAM の目安 */
export function gpuNeedText(sizeBytes: number, gpuRatio: number): string {
  const { vramGb, ramGb } = memoryNeed(sizeBytes, gpuRatio);
  return MISSING_COPY.gpuNeed(vramGb.toFixed(1), ramGb.toFixed(1));
}

/** モデルを VRAM と RAM にどう割り振るかのバー。onCommit は指を離したとき */
export function GpuRatioField({ value, onChange, onCommit }: { value: number; onChange(value: number): void; onCommit?(): void }) {
  return (
    <label className="gpu-ratio">
      <span className="field-label">{MISSING_COPY.gpuRatio}</span>
      <input
        type="range"
        min="0"
        max="100"
        step={GPU_RATIO_STEP}
        value={value}
        aria-valuetext={MISSING_COPY.gpuRatioValue(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <span className="gpu-ratio-value numeric">{MISSING_COPY.gpuRatioValue(value)}</span>
    </label>
  );
}

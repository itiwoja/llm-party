import { Box, FlaskConical, MessageSquare, Settings, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { CP, MISSING_COPY } from "../copy";
import { hrefOf, useRoute, type Route } from "../router";
import { Tooltip } from "./Tooltip";

interface Item { page: Route["page"][]; path: string; label: string; icon: ReactNode }

const ITEMS: Item[] = [
  { page: ["threads"], path: "/threads", label: CP.nav.threads, icon: <MessageSquare aria-hidden /> },
  { page: ["models"], path: "/models", label: CP.nav.models, icon: <Box aria-hidden /> },
  { page: ["presets"], path: "/presets", label: CP.nav.presets, icon: <SlidersHorizontal aria-hidden /> },
  // PG-006, PG-007 はアイコン列に出さず、評価から入る。現在地は評価に寄せる
  { page: ["evals", "runs", "compare"], path: "/evals", label: CP.nav.evals, icon: <FlaskConical aria-hidden /> },
  { page: ["settings"], path: "/settings", label: CP.nav.settings, icon: <Settings aria-hidden /> },
];

/** CMP-002。アイコンのみ。名前はツールチップと aria-label。現在地は左端の線と主色（aria-current も付ける） */
export function Rail({ updateAvailable = false }: { updateAvailable?: boolean }) {
  const route = useRoute();
  return (
    <nav className="rail" aria-label={MISSING_COPY.navigation}>
      {ITEMS.map((item) => {
        const current = item.page.includes(route.page);
        const dot = item.path === "/settings" && updateAvailable;
        return (
          <Tooltip key={item.path} label={item.label}>
            <a href={hrefOf(item.path)} className="rail-link" aria-label={item.label} aria-current={current ? "page" : undefined}>
              {item.icon}
              {dot ? <span className="rail-dot" aria-hidden /> : null}
            </a>
          </Tooltip>
        );
      })}
    </nav>
  );
}

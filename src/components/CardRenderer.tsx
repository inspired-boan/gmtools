import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useRef } from "react";
import { CARD_SIZES, CARD_THEMES, type ComponentDef, type ComponentStyle } from "../types";

/** gm-img:// 引用转为可访问 URL */
function resolveImg(raw: unknown): string {
  if (typeof raw !== "string") return raw == null ? "" : String(raw);
  return raw.replace(/gm-img:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g, (_, p1) =>
    convertFileSrc(p1, "gm-img"),
  );
}

function styleToCss(style?: ComponentStyle): React.CSSProperties {
  return {
    color: style?.color || undefined,
    fontSize: style?.fontSize || undefined,
  };
}

function MdHtml(md: string): { __html: string } {
  return { __html: marked.parse(md, { async: false }) as string };
}

/**
 * 卡片渲染器（view 模式）：模板组件 + 数据 → 卡片。
 * 供卡片节点预览与表格卡片墙复用。
 */
export default function CardRenderer({
  components,
  data,
  theme,
  size,
  autoHeight,
  onBump,
  onBind,
  flat,
}: {
  components: ComponentDef[];
  data: Record<string, unknown>;
  theme: keyof typeof CARD_THEMES;
  size: keyof typeof CARD_SIZES;
  autoHeight?: boolean;
  /** 数字字段 ±1 快捷操作（跑团面板用；不传则不显示按钮） */
  onBump?: (compId: string, delta: number) => void;
  /** 字段绑定变量入口（跑团面板用；不传则不显示按钮） */
  onBind?: (compId: string) => void;
  /** 平面模式：关闭 3D 倾斜与烫金（白板交互优先） */
  flat?: boolean;
}) {
  const t = CARD_THEMES[theme];
  const dim = CARD_SIZES[size];

  const renderComp = (c: ComponentDef): React.ReactNode => {
    const v = resolveImg(data[c.id]);
    const vStyle = styleToCss(c.style);

    switch (c.type) {
      case "group":
        return (
          <div
            key={c.id}
            className="rounded-md p-3"
            style={{ gridColumn: `span ${c.span}`, border: `1px solid ${t.border}` }}
          >
            <p className="mb-2 text-caption" style={{ color: t.accent }}>
              {c.label}
            </p>
            <div className="grid grid-cols-12 items-start gap-2">
              {(c.children ?? []).map((child) => (
                <div key={child.id} style={{ gridColumn: `span ${child.span}` }}>
                  {renderComp(child)}
                </div>
              ))}
            </div>
          </div>
        );
      case "style":
        return (
          <div
            key={c.id}
            className="rounded-md px-3 py-2 text-title-sm"
            style={{
              gridColumn: `span ${c.span}`,
              background: t.surface,
              borderLeft: `3px solid ${t.accent}`,
              ...vStyle,
            }}
          >
            {c.label}
          </div>
        );
      case "image":
        return (
          <div key={c.id} style={{ gridColumn: `span ${c.span}` }}>
            {c.label && (
              <p className="mb-1 text-caption" style={{ color: t.muted }}>
                {c.label}
              </p>
            )}
            {v ? (
              <img
                src={v}
                alt={c.label}
                className="w-full rounded-md object-cover"
                style={{ border: `1px solid ${t.border}` }}
              />
            ) : (
              <div
                className="flex h-24 items-center justify-center rounded-md text-caption"
                style={{ background: t.surface, color: t.muted }}
              >
                无图
              </div>
            )}
          </div>
        );
      case "markdown":
        return (
          <div key={c.id} style={{ gridColumn: `span ${c.span}` }}>
            {c.label && (
              <p className="mb-1 text-caption" style={{ color: t.muted }}>
                {c.label}
              </p>
            )}
            {v ? (
              <div
                className="text-body-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1 [&_strong]:font-semibold"
                style={{ color: t.ink, ...vStyle }}
                dangerouslySetInnerHTML={MdHtml(v)}
              />
            ) : (
              <p className="text-body-sm" style={{ color: t.muted }}>
                —
              </p>
            )}
          </div>
        );
      default:
        // text / number / dropdown
        return (
          <div key={c.id} className="group/field relative" style={{ gridColumn: `span ${c.span}` }}>
            {c.label && (
              <p className="mb-0.5 text-caption" style={{ color: t.muted }}>
                {c.label}
              </p>
            )}
            <p className="text-body-sm" style={{ color: t.ink, ...vStyle }}>
              {v || (c.required ? "（未填写）" : "—")}
            </p>
            {onBind && (
              <button
                className="absolute right-0 top-0 hidden rounded-xs px-1 text-[11px] group-hover/field:block"
                style={{ color: t.muted }}
                title="绑定面板变量"
                onClick={(e) => {
                  e.stopPropagation();
                  onBind(c.id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                ⛓
              </button>
            )}
            {onBump && (c.type === "number" || /^-?\d+(\.\d+)?$/.test(v)) && (
              <div
                className="absolute right-0 bottom-0 hidden items-center gap-0.5 group-hover/field:flex"
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {[1, -1].map((d) => (
                  <button
                    key={d}
                    className="rounded-xs px-1.5 text-[11px] font-bold hover:bg-primary/20"
                    style={{ color: t.accent }}
                    title={d > 0 ? "+1（右键 +5）" : "-1（右键 -5）"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onBump(c.id, d > 0 ? 1 : -1);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onBump(c.id, d > 0 ? 5 : -5);
                    }}
                  >
                    {d > 0 ? "+1" : "-1"}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
    }
  };

  // ---------- 3D 倾斜 + 烫金光泽（参考 steam0917 achievementcard/gamecard） ----------
  const cardRef = useRef<HTMLDivElement>(null);
  const foilRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    const card = cardRef.current;
    const foil = foilRef.current;
    if (!card || !foil) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const rx = (0.5 - py) * 14;
    const ry = (px - 0.5) * 14;
    card.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    card.style.filter = `brightness(${(1.08 - 0.12 * py).toFixed(3)})`;
    foil.style.opacity = "1";
    foil.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    foil.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
  };

  const handleMouseLeave = () => {
    const card = cardRef.current;
    const foil = foilRef.current;
    if (card) {
      card.style.transform = "";
      card.style.filter = "";
    }
    if (foil) foil.style.opacity = "0";
  };

  if (flat) {
    return (
      <div
        className="grid grid-cols-12 items-start gap-3 rounded-lg p-5 shadow-md"
        style={{
          width: dim.w,
          minHeight: autoHeight ? 0 : dim.h,
          background: t.bg,
          color: t.ink,
          border: `1.5px solid ${t.border}`,
        }}
      >
        {components.map(renderComp)}
      </div>
    );
  }

  return (
    <div className="card-3d-scene self-start" style={{ width: dim.w }}>
      <div ref={cardRef} className="card-3d relative" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
        <div
          className="grid grid-cols-12 items-start gap-3 rounded-lg p-5 shadow-md"
          style={{
            width: dim.w,
            minHeight: autoHeight ? 0 : dim.h,
            background: t.bg,
            color: t.ink,
            border: `1.5px solid ${t.border}`,
          }}
        >
          {components.map(renderComp)}
        </div>
        {/* 烫金光泽层：跟随光标的金色泛光 + 斜向扫过条纹 */}
        <div ref={foilRef} className="card-foil" />
      </div>
    </div>
  );
}

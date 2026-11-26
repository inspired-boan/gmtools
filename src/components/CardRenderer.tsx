import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
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
}: {
  components: ComponentDef[];
  data: Record<string, unknown>;
  theme: keyof typeof CARD_THEMES;
  size: keyof typeof CARD_SIZES;
  autoHeight?: boolean;
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
          <div key={c.id} style={{ gridColumn: `span ${c.span}` }}>
            {c.label && (
              <p className="mb-0.5 text-caption" style={{ color: t.muted }}>
                {c.label}
              </p>
            )}
            <p className="text-body-sm" style={{ color: t.ink, ...vStyle }}>
              {v || (c.required ? "（未填写）" : "—")}
            </p>
          </div>
        );
    }
  };

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

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import CollectDialog from "./CollectDialog";
import {
  CARD_SIZES,
  CARD_THEMES,
  type ComponentDef,
  type TemplateDto,
} from "../types";
import CardRenderer from "./CardRenderer";
import { useTree } from "../store";

interface NodeBrief {
  nodeId: string;
  name: string;
}

interface CardData {
  templateId: string;
  data: Record<string, unknown>;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export default function CardPane({ nodeId }: { nodeId: string }) {
  const [card, setCard] = useState<CardData | null>(null);
  const [tpl, setTpl] = useState<TemplateDto | null>(null);
  const [tplMissing, setTplMissing] = useState(false);
  const [templates, setTemplates] = useState<NodeBrief[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty">("saved");
  const [formHidden, setFormHidden] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const pending = useRef(false);
  const stateRef = useRef<CardData | null>(null);
  stateRef.current = card;

  const flushSave = useCallback(async () => {
    const cur = stateRef.current;
    if (!pending.current || !cur) return;
    pending.current = false;
    try {
      await invoke("save_card", { nodeId, templateId: cur.templateId, data: cur.data });
      setSaveState("saved");
    } catch (e) {
      setError(String(e));
    }
  }, [nodeId]);

  const scheduleSave = () => {
    pending.current = true;
    setSaveState("dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushSave(), 800);
  };

  useEffect(() => {
    void (async () => {
      try {
        const c = await invoke<CardData | null>("get_card", { nodeId });
        setCard(c);
        if (c) {
          try {
            setTpl(await invoke<TemplateDto>("get_template", { nodeId: c.templateId }));
            setTplMissing(false);
          } catch {
            setTpl(null);
            setTplMissing(true);
          }
        } else {
          setTemplates(await invoke<NodeBrief[]>("list_templates_for", { nodeId }));
        }
        setLoaded(true);
      } catch (e) {
        setError(String(e));
        setLoaded(true);
      }
    })();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      void flushSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const chooseTemplate = async (templateId: string) => {
    try {
      await invoke("save_card", { nodeId, templateId, data: {} });
      const c = await invoke<CardData | null>("get_card", { nodeId });
      setCard(c);
      setTpl(await invoke<TemplateDto>("get_template", { nodeId: templateId }));
      setTplMissing(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const setValue = (compId: string, value: unknown) => {
    setCard((c) => (c ? { ...c, data: { ...c.data, [compId]: value } } : c));
    scheduleSave();
  };

  const uploadImage = async (compId: string, file: File) => {
    try {
      const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
      const ref = await invoke<{ id: string; ext: string }>("save_image", {
        dataBase64: await fileToBase64(file),
        ext,
      });
      setValue(compId, `gm-img://${ref.id}.${ref.ext}`);
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) return <div className="p-6 text-body-sm text-error">{error}</div>;
  if (!loaded) return <div className="p-6 text-body-sm text-muted-soft">加载中…</div>;

  // 引导态：未选模板（或模板丢失重选）
  if (!card || !tpl) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="w-96 rounded-lg border border-hairline bg-canvas p-6 text-center shadow-sm">
          <h2 className="text-title-md text-ink">
            {tplMissing ? "模板已丢失，请重新选择" : "选择一个模板"}
          </h2>
          <p className="mt-1 text-caption text-muted">
            可选模板 = 本规则下的模板 + 全局模板（无规则归属）
          </p>
          {templates.length > 0 ? (
            <div className="mt-4 space-y-2">
              {templates.map((t) => (
                <button
                  key={t.nodeId}
                  className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink hover:border-primary hover:text-primary"
                  onClick={() => void chooseTemplate(t.nodeId)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-body-sm text-muted">
              还没有可用模板——先在某规则下新建「模板」节点并设计它。
            </p>
          )}
        </div>
      </div>
    );
  }

  const inputCls =
    "h-9 w-full rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15";

  const renderField = (c: ComponentDef): React.ReactNode => {
    const raw = card.data[c.id];
    const value = typeof raw === "string" || typeof raw === "number" ? raw : "";
    const star = c.required && <span className="text-error">*</span>;

    switch (c.type) {
      case "text":
        return (
          <label key={c.id} className="block" style={{ gridColumn: `span ${c.span}` }}>
            <span className="mb-1 block text-caption text-muted-soft">
              {c.label} {star}
            </span>
            <input
              className={inputCls}
              placeholder={c.placeholder}
              value={value}
              onChange={(e) => setValue(c.id, e.target.value)}
            />
          </label>
        );
      case "number":
        return (
          <label key={c.id} className="block" style={{ gridColumn: `span ${c.span}` }}>
            <span className="mb-1 block text-caption text-muted-soft">
              {c.label} {star}
            </span>
            <input
              type="number"
              className={inputCls}
              value={value}
              onChange={(e) => setValue(c.id, e.target.value === "" ? undefined : Number(e.target.value))}
            />
          </label>
        );
      case "markdown":
        return (
          <label key={c.id} className="block" style={{ gridColumn: `span ${c.span}` }}>
            <span className="mb-1 block text-caption text-muted-soft">
              {c.label} {star}
            </span>
            <textarea
              className="h-28 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-body-sm text-ink focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15"
              placeholder={c.placeholder ?? "支持 markdown"}
              value={value}
              onChange={(e) => setValue(c.id, e.target.value)}
            />
          </label>
        );
      case "dropdown":
        return (
          <label key={c.id} className="block" style={{ gridColumn: `span ${c.span}` }}>
            <span className="mb-1 block text-caption text-muted-soft">
              {c.label} {star}
            </span>
            <select
              className={inputCls}
              value={value}
              onChange={(e) => setValue(c.id, e.target.value)}
            >
              <option value="">（未选择）</option>
              {(c.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        );
      case "image": {
        const src =
          typeof card.data[c.id] === "string"
            ? (card.data[c.id] as string).replace(
                /gm-img:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g,
                (_, p1) => convertFileSrc(p1, "gm-img"),
              )
            : "";
        return (
          <div key={c.id} style={{ gridColumn: `span ${c.span}` }}>
            <span className="mb-1 block text-caption text-muted-soft">
              {c.label} {star}
            </span>
            {src ? (
              <div className="relative">
                <img src={src} alt={c.label} className="max-h-48 rounded-md object-cover" />
                <button
                  className="absolute top-1 right-1 rounded-xs bg-ink/60 px-1.5 py-0.5 text-caption text-on-dark"
                  onClick={() => setValue(c.id, undefined)}
                >
                  移除
                </button>
              </div>
            ) : (
              <label className="flex h-24 cursor-pointer items-center justify-center rounded-md border border-dashed border-hairline text-caption text-muted hover:border-primary hover:text-primary">
                点击上传图片
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadImage(c.id, f);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        );
      }
      case "group":
        return (
          <fieldset
            key={c.id}
            className="rounded-md border border-hairline p-3"
            style={{ gridColumn: `span ${c.span}` }}
          >
            <legend className="px-1 text-caption text-primary">{c.label}</legend>
            <div className="grid grid-cols-12 items-start gap-3">{(c.children ?? []).map(renderField)}</div>
          </fieldset>
        );
      case "style":
        return null; // 风格区块是装饰组件，不产生填写项
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* 左：填写表单（可收起） */}
      {!formHidden && (
        <div className="flex w-[420px] shrink-0 flex-col border-r border-hairline">
          <div className="flex items-center border-b border-hairline-soft px-4 py-2">
            <p className="text-title-sm text-ink">填写</p>
            <span className="ml-auto text-caption text-muted-soft">
              {saveState === "dirty" ? "未保存" : "已自动保存"}
            </span>
            <button
              className="ml-3 h-7 rounded-md border border-hairline px-2 text-caption text-ink hover:border-primary hover:text-primary"
              title="复制一份到某个卡片库"
              onClick={() => setCollectOpen(true)}
            >
              ★ 收藏
            </button>
            <button
              className="ml-3 h-7 w-7 rounded-md text-caption text-muted hover:bg-surface-soft hover:text-ink"
              title="收起填写面板"
              onClick={() => setFormHidden(true)}
            >
              ‹
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-12 items-start gap-3">{tpl.components.map(renderField)}</div>
          </div>
        </div>
      )}

      {/* 右：实时预览 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center border-b border-hairline-soft px-4 py-2">
          {formHidden ? (
            <button
              className="h-7 rounded-md px-2 text-caption text-muted hover:bg-surface-soft hover:text-ink"
              title="展开填写面板"
              onClick={() => setFormHidden(false)}
            >
              › 展开填写
            </button>
          ) : (
            <p className="text-title-sm text-ink">预览</p>
          )}
          <span className="ml-3 text-caption text-muted-soft">
            {CARD_THEMES[tpl.theme].name} · {CARD_SIZES[tpl.size].name} · 悬停卡片查看 3D 烫金效果
          </span>
        </div>
        <div className="flex flex-1 justify-center overflow-y-auto bg-surface-soft p-6">
          <CardRenderer
            components={tpl.components}
            data={card.data}
            theme={tpl.theme}
            size={tpl.size}
            autoHeight={tpl.autoHeight}
          />
        </div>
      </div>

      {collectOpen && (
        <CollectDialog
          kind="card"
          sourceNodeId={nodeId}
          onClose={() => setCollectOpen(false)}
          onDone={() => void useTree.getState().load()}
        />
      )}
    </div>
  );
}

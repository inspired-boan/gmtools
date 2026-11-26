import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CARD_SIZES,
  CARD_THEMES,
  type CardSize,
  type CardThemeKey,
  type ComponentDef,
  type ComponentType,
} from "../types";

// ---------- 组件树操作工具（不可变） ----------

function findList(
  list: ComponentDef[],
  id: string,
): { list: ComponentDef[]; index: number; parent: ComponentDef | null } | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, index: i, parent: null };
    const kids = list[i].children;
    if (kids) {
      const hit = findList(kids, id);
      if (hit) return { ...hit, parent: list[i] };
    }
  }
  return null;
}

function newComponent(type: ComponentType): ComponentDef {
  const id = "c_" + Math.random().toString(36).slice(2, 8);
  const base: ComponentDef = { id, type, label: "", span: 6 };
  switch (type) {
    case "text":
      return { ...base, label: "文本", placeholder: "填写内容" };
    case "markdown":
      return { ...base, label: "描述", span: 12 };
    case "number":
      return { ...base, label: "数值", default: 0 };
    case "dropdown":
      return { ...base, label: "状态", options: ["选项一", "选项二"], default: "选项一" };
    case "image":
      return { ...base, label: "图片", span: 12 };
    case "group":
      return { ...base, label: "分组", span: 12, children: [] };
    case "style":
      return { ...base, label: "风格区块", span: 12 };
  }
}

/** 拖放会话状态（ref 级共享，跨 CompList 实例；dataTransfer 仅作浏览器机制） */
let dragCompId: string | null = null;
let dropTargetZone: { id: string | null; zone: "before" | "inside" | "after" } | null = null;

/** 移动组件：先移除 dragId，再在移除后的列表上按 targetId + zone 重新解析插入位置 */
function moveComponent(
  list: ComponentDef[],
  dragId: string,
  targetId: string | null, // null = 根列表尾部（画布空白处落下）
  zone: "before" | "inside" | "after",
): ComponentDef[] | null {
  const src = findList(list, dragId);
  if (!src) return null;
  const comp = src.list[src.index];
  const without = rebuildRemove(list, dragId);

  if (targetId === null) {
    // 移到根列表末尾（原本就在末尾则不动）
    if (src.parent === null && src.index === list.length - 1) return null;
    return [...without, comp];
  }

  const tgt = findList(without, targetId);
  if (!tgt) return null;
  const targetDef = tgt.list[tgt.index];
  const targetParentId = tgt.parent ? tgt.parent.id : null;

  // 约束：不能移进自己的子树；分组只能留在根层级
  if (targetParentId === dragId) return null;
  if (targetParentId && findList([comp], targetParentId)) return null;
  if (comp.type === "group" && (targetParentId !== null || zone === "inside")) return null;
  if (zone === "inside" && targetDef.type !== "group") return null;

  if (zone === "inside") {
    return rebuildInsert(without, targetId, comp, targetDef.children?.length ?? 0);
  }

  const idx = tgt.index + (zone === "after" ? 1 : 0);
  if (targetParentId === null) {
    return [...without.slice(0, idx), comp, ...without.slice(idx)];
  }
  return rebuildInsert(without, targetParentId, comp, idx);
}

function rebuildInsert(
  list: ComponentDef[],
  parentId: string,
  comp: ComponentDef,
  index: number,
): ComponentDef[] {
  return list.map((c) => {
    if (c.id === parentId) {
      const kids = c.children ?? [];
      const idx = Math.min(Math.max(0, index), kids.length);
      return { ...c, children: [...kids.slice(0, idx), comp, ...kids.slice(idx)] };
    }
    if (c.children) return { ...c, children: rebuildInsert(c.children, parentId, comp, index) };
    return c;
  });
}

function rebuildUpdate(
  list: ComponentDef[],
  id: string,
  patch: Partial<ComponentDef>,
): ComponentDef[] {
  return list.map((c) => {
    if (c.id === id) return { ...c, ...patch };
    if (c.children) return { ...c, children: rebuildUpdate(c.children, id, patch) };
    return c;
  });
}

function rebuildRemove(list: ComponentDef[], id: string): ComponentDef[] {
  return list
    .filter((c) => c.id !== id)
    .map((c) => (c.children ? { ...c, children: rebuildRemove(c.children, id) } : c));
}

// ---------- 编辑器 ----------

const PALETTE: { type: ComponentType; name: string }[] = [
  { type: "text", name: "文本输入" },
  { type: "markdown", name: "Markdown" },
  { type: "number", name: "数字输入" },
  { type: "dropdown", name: "下拉框" },
  { type: "image", name: "图片" },
  { type: "group", name: "分组容器" },
  { type: "style", name: "风格区块" },
];

export default function TemplateEditor({ nodeId }: { nodeId: string }) {
  const [tpl, setTpl] = useState<{
    size: CardSize;
    theme: CardThemeKey;
    autoHeight: boolean;
    components: ComponentDef[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [usingCount, setUsingCount] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const timer = useRef<number | null>(null);
  const pending = useRef(false);
  const nodeIdRef = useRef(nodeId);

  useEffect(() => {
    nodeIdRef.current = nodeId;
    void (async () => {
      try {
        const t = await invoke<{
          size: CardSize;
          theme: CardThemeKey;
          autoHeight: boolean;
          components: ComponentDef[];
        }>("get_template", { nodeId });
        setTpl({ size: t.size, theme: t.theme, autoHeight: t.autoHeight, components: t.components });
        setUsingCount(await invoke<number>("count_cards_using", { templateNodeId: nodeId }));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [nodeId]);

  const flushSave = useCallback(async () => {
    if (!pending.current || !tpl) return;
    pending.current = false;
    setSaveState("saving");
    try {
      const n = await invoke<number>("save_template", {
        nodeId: nodeIdRef.current,
        size: tpl.size,
        theme: tpl.theme,
        autoHeight: tpl.autoHeight,
        components: tpl.components,
      });
      setUsingCount(n);
      setSaveState("saved");
    } catch (e) {
      setError(String(e));
      setSaveState("dirty");
    }
  }, [tpl]);

  const mutate = (fn: (components: ComponentDef[]) => ComponentDef[]) => {
    setTpl((t) => (t ? { ...t, components: fn(t.components) } : t));
    pending.current = true;
    setSaveState("dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushSaveRef.current(), 800);
  };

  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;

  // 卸载前冲刷
  useEffect(() => {
    return () => {
      void flushSaveRef.current();
    };
  }, []);

  if (error) return <div className="p-6 text-body-sm text-error">{error}</div>;
  if (!tpl) return <div className="p-6 text-body-sm text-muted-soft">加载中…</div>;

  const selected = selectedId ? findList(tpl.components, selectedId) : null;
  const selectedDef = selected ? selected.list[selected.index] : null;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：尺寸 / 主题 / 状态 */}
      <div className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2">
        <select
          className="h-8 rounded-md border border-hairline bg-canvas px-2 text-caption text-ink focus:outline-none"
          value={tpl.size}
          onChange={(e) => {
            setTpl({ ...tpl, size: e.target.value as CardSize });
            pending.current = true;
            setSaveState("dirty");
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void flushSaveRef.current(), 800);
          }}
        >
          {Object.entries(CARD_SIZES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.name}（{v.w}×{v.h}）
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-hairline bg-canvas px-2 text-caption text-ink focus:outline-none"
          value={tpl.theme}
          onChange={(e) => {
            setTpl({ ...tpl, theme: e.target.value as CardThemeKey });
            pending.current = true;
            setSaveState("dirty");
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void flushSaveRef.current(), 800);
          }}
        >
          {Object.entries(CARD_THEMES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-caption text-ink" title="高度随组件内容自动撑开，不固定卡片高度">
          <input
            type="checkbox"
            checked={tpl.autoHeight}
            onChange={(e) => {
              setTpl({ ...tpl, autoHeight: e.target.checked });
              pending.current = true;
              setSaveState("dirty");
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void flushSaveRef.current(), 800);
            }}
          />
          自动高度
        </label>
        {usingCount > 0 && (
          <span className="rounded-pill bg-surface-card px-2.5 py-0.5 text-caption text-ink">
            已被 {usingCount} 张卡片使用
          </span>
        )}
        <span className="ml-auto text-caption text-muted-soft">
          {saveState === "saving" ? "保存中…" : saveState === "dirty" ? "未保存" : "已自动保存"}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：组件库 */}
        <div className="w-40 shrink-0 overflow-y-auto border-r border-hairline-soft p-3">
          <p className="mb-2 text-caption text-muted-soft">组件库（点击添加）</p>
          {PALETTE.map((p) => (
            <button
              key={p.type}
              className="mb-2 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-left text-caption text-ink hover:border-primary hover:text-primary"
              onClick={() => {
                const comp = newComponent(p.type);
                // 选中的是分组则加入分组内，否则追加到根层
                mutate((l) =>
                  selectedDef?.type === "group" && p.type !== "group"
                    ? rebuildInsert(l, selectedDef.id, comp, selectedDef.children?.length ?? 0)
                    : [...l, comp],
                );
                setSelectedId(comp.id);
              }}
            >
              + {p.name}
            </button>
          ))}
        </div>

        {/* 中：画布 */}
        <div className="flex flex-1 justify-center overflow-y-auto bg-surface-soft p-6">
          <Canvas
            size={tpl.size}
            theme={tpl.theme}
            autoHeight={tpl.autoHeight}
            components={tpl.components}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={(dragId, targetId, zone) =>
              mutate((l) => moveComponent(l, dragId, targetId, zone) ?? l)
            }
            onRemove={(id) => {
              mutate((l) => rebuildRemove(l, id));
              setSelectedId(null);
            }}
          />
        </div>

        {/* 右：属性面板 */}
        <div className="w-64 shrink-0 overflow-y-auto border-l border-hairline-soft p-4">
          {selectedDef ? (
            <PropsPanel
              def={selectedDef}
              onChange={(patch) => mutate((l) => rebuildUpdate(l, selectedDef.id, patch))}
            />
          ) : (
            <p className="text-caption text-muted">选中画布上的组件以编辑属性</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 画布 ----------

function Canvas({
  size,
  theme,
  autoHeight,
  components,
  selectedId,
  onSelect,
  onMove,
  onRemove,
}: {
  size: CardSize;
  theme: CardThemeKey;
  autoHeight: boolean;
  components: ComponentDef[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (dragId: string, targetId: string | null, zone: "before" | "inside" | "after") => void;
  onRemove: (id: string) => void;
}) {
  const t = CARD_THEMES[theme];
  const dim = CARD_SIZES[size];
  return (
    <div
      className="self-start rounded-lg p-5 shadow-md"
      style={{
        width: dim.w,
        minHeight: autoHeight ? 0 : dim.h,
        background: t.bg,
        color: t.ink,
        border: `1.5px solid ${t.border}`,
      }}
      onClick={() => onSelect(null)}
      // 画布任意位置都允许放置：落在空白处 = 移到根列表末尾
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const dragId = dragCompId ?? e.dataTransfer.getData("text/gm-comp");
        if (!dragId) return;
        dropTargetZone = null;
        onMove(dragId, null, "after");
      }}
    >
      <CompList
        list={components}

        theme={t}
        selectedId={selectedId}
        onSelect={onSelect}
        onMove={onMove}
        onRemove={onRemove}
      />
    </div>
  );
}

function CompList({
  list,
  theme,
  selectedId,
  onSelect,
  onMove,
  onRemove,
}: {
  list: ComponentDef[];
  theme: (typeof CARD_THEMES)[CardThemeKey];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (dragId: string, targetId: string | null, zone: "before" | "inside" | "after") => void;
  onRemove: (id: string) => void;
}) {
  const [dropZone, setDropZone] = useState<{ id: string; zone: "before" | "inside" | "after" } | null>(null);
  const [tailDrop, setTailDrop] = useState(false);

  const resolveZone = (target: ComponentDef, rel: number): "before" | "inside" | "after" => {
    if (target.type === "group") return rel < 0.2 ? "before" : rel > 0.8 ? "after" : "inside";
    return rel < 0.5 ? "before" : "after";
  };

  const handleDrop = (e: React.DragEvent, target: ComponentDef | null, isTail: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setDropZone(null);
    setTailDrop(false);
    const dragId = dragCompId ?? e.dataTransfer.getData("text/gm-comp");
    if (!dragId) return;
    const zone = dropTargetZone?.zone ?? (isTail ? "after" : "after");
    dropTargetZone = null;
    if (isTail || !target) {
      onMove(dragId, null, "after");
      return;
    }
    onMove(dragId, target.id, zone);
  };

  return (
    <div className="grid grid-cols-12 items-start gap-2" onClick={(e) => e.stopPropagation()}>
      {list.map((c) => (
        <div
          key={c.id}
          style={{
            gridColumn: `span ${Math.max(1, Math.min(12, c.span))} / span ${Math.max(1, Math.min(12, c.span))}`,
          }}
        >
          <div
            className={`group rounded-md p-2 ${selectedId === c.id ? "ring-2 ring-primary" : ""} ${
              dropZone?.id === c.id && dropZone.zone === "inside" ? "ring-2 ring-accent-teal" : ""
            }`}
            style={{
              background: theme.surface,
              border: `1px dashed ${theme.border}`,
            }}
            draggable
            onDragStart={(e) => {
              dragCompId = c.id;
              e.dataTransfer.setData("text/gm-comp", c.id);
              e.dataTransfer.effectAllowed = "move";
              e.stopPropagation();
            }}
            onDragEnd={() => {
              dragCompId = null;
              dropTargetZone = null;
              setDropZone(null);
              setTailDrop(false);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              const rel = (e.clientY - r.top) / r.height;
              const zone = resolveZone(c, rel);
              dropTargetZone = { id: c.id, zone };
              setDropZone({ id: c.id, zone });
            }}
            onDragLeave={() => setDropZone(null)}
            onDrop={(e) => handleDrop(e, c, false)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(c.id);
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-caption" style={{ color: theme.ink }}>
                {c.type === "group" ? "▦ " : c.type === "style" ? "◆ " : ""}
                {c.label || `（${c.type}）`}
              </span>
              <span className="text-[10px]" style={{ color: theme.muted }}>
                {c.span}列
              </span>
              <button
                className={`ml-auto rounded-xs px-1 text-[11px] hover:bg-primary/10 hover:text-error ${
                  selectedId === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                style={{ color: theme.muted }}
                title="删除组件"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(c.id);
                }}
              >
                ✕
              </button>
            </div>
            {c.type === "group" && (
              <div
                className="mt-2 rounded-md p-2"
                style={{ border: `1px solid ${theme.border}` }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, c, false)}
              >
                {c.children && c.children.length > 0 ? (
                  <CompList
                    list={c.children}

                    theme={theme}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onMove={onMove}
                    onRemove={onRemove}
                  />
                ) : (
                  <p className="py-2 text-center text-[11px]" style={{ color: theme.muted }}>
                    拖入组件或点击左侧组件库添加
                  </p>
                )}
              </div>
            )}
          </div>
          {dropZone?.id === c.id && (dropZone.zone === "before" || dropZone.zone === "after") && (
            <div className="my-0.5 h-0.5 rounded-full bg-primary" />
          )}
        </div>
      ))}
      {/* 尾部接收区 */}
      <div
        className={`col-span-12 min-h-8 rounded-md ${tailDrop ? "ring-2 ring-primary" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setTailDrop(true);
        }}
        onDragLeave={() => setTailDrop(false)}
        onDrop={(e) => handleDrop(e, null, true)}
      />
    </div>
  );
}

// ---------- 属性面板 ----------

function PropsPanel({ def, onChange }: { def: ComponentDef; onChange: (patch: Partial<ComponentDef>) => void }) {
  const label = "mb-1 block text-caption text-muted-soft";
  const input =
    "h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-body-sm text-ink focus:border-primary focus:outline-none";
  return (
    <div className="space-y-3">
      <p className="text-title-sm text-ink">
        组件属性
        <span className="ml-1.5 text-caption text-muted-soft">{def.type}</span>
      </p>

      <div>
        <label className={label}>标签</label>
        <input className={input} value={def.label} onChange={(e) => onChange({ label: e.target.value })} />
      </div>

      {def.type === "text" && (
        <div>
          <label className={label}>占位提示</label>
          <input
            className={input}
            value={def.placeholder ?? ""}
            onChange={(e) => onChange({ placeholder: e.target.value })}
          />
        </div>
      )}

      {def.type === "number" && (
        <div>
          <label className={label}>默认值</label>
          <input
            type="number"
            className={input}
            value={def.default != null ? String(def.default) : ""}
            onChange={(e) => onChange({ default: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </div>
      )}

      {def.type === "dropdown" && (
        <div>
          <label className={label}>选项（每行一个）</label>
          <textarea
            className="h-24 w-full rounded-sm border border-hairline bg-canvas px-2 py-1 text-body-sm text-ink focus:border-primary focus:outline-none"
            value={(def.options ?? []).join("\n")}
            onChange={(e) => onChange({ options: e.target.value.split("\n").filter((s) => s.trim()) })}
          />
        </div>
      )}

      <div>
        <label className={label}>跨列数（1~12）</label>
        <input
          type="number"
          min={1}
          max={12}
          className={input}
          value={def.span}
          onChange={(e) =>
            onChange({ span: Math.max(1, Math.min(12, Number(e.target.value) || 6)) })
          }
        />
      </div>

      <label className="flex items-center gap-2 text-body-sm text-ink">
        <input
          type="checkbox"
          checked={!!def.required}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        必填
      </label>

      <div className="border-t border-hairline-soft pt-3">
        <p className="mb-2 text-caption text-muted-soft">样式覆盖（留空跟随主题）</p>
        <div className="flex gap-2">
          <input
            type="color"
            className="h-8 w-10 cursor-pointer rounded-sm border border-hairline"
            value={def.style?.color || "#cc785c"}
            onChange={(e) => onChange({ style: { ...def.style, color: e.target.value } })}
            title="文字颜色"
          />
          <select
            className="h-8 flex-1 rounded-sm border border-hairline bg-canvas px-1 text-caption text-ink focus:outline-none"
            value={def.style?.fontSize || ""}
            onChange={(e) => onChange({ style: { ...def.style, fontSize: e.target.value } })}
          >
            <option value="">默认字号</option>
            <option value="14px">小</option>
            <option value="18px">中</option>
            <option value="24px">大</option>
            <option value="32px">特大</option>
          </select>
        </div>
      </div>
    </div>
  );
}

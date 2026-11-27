import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTree } from "../store";
import type { NodeDto, TemplateDto } from "../types";
import CardRenderer from "./CardRenderer";

interface PanelItem {
  cardNodeId: string;
  x: number;
  y: number;
}

interface CachedCard {
  tpl: TemplateDto;
  data: Record<string, unknown>;
}

interface PanelVar {
  name: string;
  value: string;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;

/** v3 跑团面板：白板 + 共享变量中台（DESIGN.md §8.3） */
export default function PanelBoard({ nodeId }: { nodeId: string }) {
  const { nodes, select } = useTree();
  const [items, setItems] = useState<PanelItem[]>([]);
  const [cards, setCards] = useState<Record<string, CachedCard | null>>({});
  const [vars, setVars] = useState<PanelVar[]>([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 60, y: 40 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddList, setShowAddList] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [binding, setBinding] = useState<{ cardNodeId: string; compId: string } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  // 视口状态（缩放/平移）持久化：切节点再回来不重置
  const viewRef = useRef({ zoom: 1, pan: { x: 60, y: 40 } });
  viewRef.current = { zoom, pan };
  const viewSaveTimer = useRef<number | null>(null);
  const saveView = useCallback(() => {
    void invoke("set_setting", {
      key: `panelview:${nodeId}`,
      value: JSON.stringify(viewRef.current),
    }).catch(() => {});
  }, [nodeId]);
  const scheduleSaveView = useCallback(() => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = window.setTimeout(saveView, 500);
  }, [saveView]);

  const dragCard = useRef<{
    cardNodeId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const panDrag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const loadBoard = useCallback(async () => {
    try {
      const list = await invoke<PanelItem[]>("get_panel", { nodeId });
      setItems(list);
      const varsList = await invoke<PanelVar[]>("get_panel_vars", { nodeId });
      setVars(varsList);
      const entries = await Promise.all(
        list.map(async (it): Promise<readonly [string, CachedCard | null]> => {
          try {
            const c = await invoke<{ templateId: string; data: Record<string, unknown> } | null>(
              "get_card",
              { nodeId: it.cardNodeId },
            );
            if (!c) return [it.cardNodeId, null] as const;
            const t = await invoke<TemplateDto>("get_template", { nodeId: c.templateId });
            return [it.cardNodeId, { tpl: t, data: c.data }] as const;
          } catch {
            return [it.cardNodeId, null] as const;
          }
        }),
      );
      setCards(Object.fromEntries(entries));
      setLoaded(true);
    } catch (e) {
      setError(String(e));
      setLoaded(true);
    }
  }, [nodeId]);

  useEffect(() => {
    setLoaded(false);
    void (async () => {
      try {
        const saved = await invoke<string | null>("get_setting", { key: `panelview:${nodeId}` });
        if (saved) {
          const v = JSON.parse(saved) as { zoom: number; pan: { x: number; y: number } };
          if (v.zoom && v.pan) {
            setZoom(v.zoom);
            setPan(v.pan);
          }
        }
      } catch {
        /* 无存档则用默认 */
      }
      loadBoard();
    })();
    // 卸载不写视口——所有变更已在操作时即时保存（StrictMode 卸载会以默认值覆写存档）
    return () => {
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    };
  }, [loadBoard, nodeId]);

  const addCard = async (cardNodeId: string, x: number, y: number) => {
    try {
      await invoke("set_panel_item", { nodeId, cardNodeId, x, y });
      await loadBoard();
    } catch (e) {
      setError(String(e));
    }
  };

  // ---------- 变量 ----------
  const resolveValue = (raw: unknown): unknown => {
    if (typeof raw === "string" && raw.startsWith("@") && raw.length > 1) {
      const v = vars.find((x) => x.name === raw.slice(1));
      return v ? v.value : `${raw}（变量缺失）`;
    }
    return raw;
  };

  const bump = async (cardNodeId: string, compId: string, delta: number) => {
    try {
      const r = await invoke<{ resolved: number; var: string | null }>("bump_card_value", {
        panelId: nodeId,
        cardNodeId,
        compId,
        delta,
      });
      if (r.var) {
        setVars((vs) =>
          vs.map((v) => (v.name === r.var ? { ...v, value: String(r.resolved) } : v)),
        );
      } else {
        setCards((m) => {
          const c = m[cardNodeId];
          if (!c) return m;
          return { ...m, [cardNodeId]: { ...c, data: { ...c.data, [compId]: r.resolved } } };
        });
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const applyBinding = async (cardNodeId: string, compId: string, varName: string) => {
    const c = cards[cardNodeId];
    if (!c) return;
    const newData = { ...c.data, [compId]: `@${varName}` };
    try {
      await invoke("save_card", { nodeId: cardNodeId, templateId: c.tpl.nodeId, data: newData });
      setCards((m) => ({ ...m, [cardNodeId]: { ...c, data: newData } }));
    } catch (e) {
      setError(String(e));
    }
  };

  // ---------- 卡片拖动 ----------
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragCard.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / zoom;
      const dy = (e.clientY - d.startY) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      setItems((list) =>
        list.map((it) =>
          it.cardNodeId === d.cardNodeId ? { ...it, x: d.origX + dx, y: d.origY + dy } : it,
        ),
      );
    };
    const up = () => {
      const d = dragCard.current;
      if (!d) return;
      dragCard.current = null;
      if (d.moved) {
        setItems((list) => {
          const final = list.find((it) => it.cardNodeId === d.cardNodeId);
          if (final) {
            void invoke("set_panel_item", {
              nodeId,
              cardNodeId: d.cardNodeId,
              x: final.x,
              y: final.y,
            }).catch((e) => setError(String(e)));
          }
          return list;
        });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [zoom, nodeId]);

  // ---------- 画布平移 ----------
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const p = panDrag.current;
      if (!p) return;
      setPan({ x: p.origX + (e.clientX - p.startX), y: p.origY + (e.clientY - p.startY) });
    };
    const up = () => {
      panDrag.current = null;
      scheduleSaveView();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [scheduleSaveView]);

  const boardFromEvent = (e: React.MouseEvent | React.DragEvent): { x: number; y: number } => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return {
      x: (e.clientX - r.left - pan.x) / zoom,
      y: (e.clientY - r.top - pan.y) / zoom,
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r) return;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    setPan((p) => ({
      x: mx - ((mx - p.x) * next) / zoom,
      y: my - ((my - p.y) * next) / zoom,
    }));
    setZoom(next);
    scheduleSaveView();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/gm-node");
    if (!dragId) return;
    const node = nodes.find((n) => n.id === dragId);
    if (!node || node.nodeType !== "card") {
      window.alert("只能把卡片节点拖入跑团面板");
      return;
    }
    if (items.some((it) => it.cardNodeId === dragId)) {
      window.alert("该卡片已在面板上");
      return;
    }
    const pos = boardFromEvent(e);
    void addCard(dragId, pos.x - 100, pos.y - 60);
  };

  const cardNodes = nodes.filter((n) => n.nodeType === "card");

  if (error) return <div className="p-6 text-body-sm text-error">{error}</div>;
  if (!loaded) return <div className="p-6 text-body-sm text-muted-soft">加载中…</div>;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2">
        <p className="text-title-sm text-ink">跑团面板</p>
        <button
          className="h-8 rounded-md bg-primary px-3 text-caption text-on-primary hover:bg-primary-active"
          onClick={() => setShowAddList((v) => !v)}
        >
          + 添加卡片
        </button>
        <button
          className={`h-8 rounded-md px-3 text-caption ${
            drawerOpen ? "bg-surface-cream-strong text-ink" : "border border-hairline text-muted hover:bg-surface-soft"
          }`}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          变量（{vars.length}）
        </button>
        <span className="ml-auto text-caption text-muted-soft">
          空白处拖动平移 · Ctrl+滚轮缩放（{Math.round(zoom * 100)}%）· 悬停数字字段 ±1 / ⛓ 绑定
        </span>
      </div>

      {/* 添加卡片列表 */}
      {showAddList && (
        <div className="max-h-40 overflow-y-auto border-b border-hairline-soft bg-canvas px-4 py-2">
          {cardNodes.length === 0 ? (
            <p className="text-caption text-muted">还没有卡片节点——先在树上创建。</p>
          ) : (
            cardNodes.map((n: NodeDto) => (
              <button
                key={n.id}
                className="mr-2 mb-1 h-8 rounded-md border border-hairline bg-canvas px-2.5 text-caption text-ink hover:border-primary hover:text-primary"
                onClick={() => {
                  void addCard(n.id, 60 + items.length * 30, 60 + items.length * 30);
                  setShowAddList(false);
                }}
              >
                {n.name}
              </button>
            ))
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 白板 */}
        <div
          ref={viewportRef}
          className="relative flex-1 overflow-hidden bg-surface-soft"
          style={{
            backgroundImage: "radial-gradient(circle, #e6dfd8 1px, transparent 1px)",
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
            cursor: panDrag.current ? "grabbing" : "default",
          }}
          onWheel={onWheel}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-panel-card]")) return;
            panDrag.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {items.map((it) => {
              const cached = cards[it.cardNodeId];
              const node = nodes.find((n) => n.id === it.cardNodeId);
              const valid = node && cached;
              const resolvedData = cached
                ? Object.fromEntries(
                    Object.entries(cached.data).map(([k, v]) => [k, resolveValue(v)]),
                  )
                : {};
              return (
                <div
                  key={it.cardNodeId}
                  data-panel-card
                  className="absolute"
                  style={{ left: it.x, top: it.y }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    dragCard.current = {
                      cardNodeId: it.cardNodeId,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: it.x,
                      origY: it.y,
                      moved: false,
                    };
                  }}
                  onDoubleClick={() => {
                    if (dragCard.current?.moved) return;
                    if (node) select(node.id);
                  }}
                >
                  {valid ? (
                    <CardRenderer
                      components={cached.tpl.components}
                      data={resolvedData}
                      theme={cached.tpl.theme}
                      size={cached.tpl.size}
                      autoHeight={cached.tpl.autoHeight}
                      flat
                      onBump={(compId, delta) => void bump(it.cardNodeId, compId, delta)}
                      onBind={(compId) => setBinding({ cardNodeId: it.cardNodeId, compId })}
                    />
                  ) : (
                    <div className="w-[240px] rounded-lg border border-dashed border-hairline bg-canvas p-4 text-center">
                      <p className="text-caption text-muted">
                        {node ? "卡片加载失败" : "引用已失效（卡片已被删除）"}
                      </p>
                      <button
                        className="mt-2 h-8 rounded-md border border-hairline px-3 text-caption text-error hover:bg-surface-soft"
                        onClick={() => {
                          void invoke("remove_panel_item", { nodeId, cardNodeId: it.cardNodeId })
                            .then(loadBoard)
                            .catch((e) => setError(String(e)));
                        }}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {items.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="text-body-sm text-muted">
                从左侧树把「卡片」节点拖进来，或点上方「+ 添加卡片」
              </p>
            </div>
          )}
        </div>

        {/* 变量抽屉 */}
        {drawerOpen && (
          <VarDrawer nodeId={nodeId} vars={vars} onChange={setVars} />
        )}
      </div>

      {/* 绑定变量弹窗 */}
      {binding && (
        <BindVarDialog
          vars={vars}
          onCancel={() => setBinding(null)}
          onPick={(varName) => {
            void applyBinding(binding.cardNodeId, binding.compId, varName);
            setBinding(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- 变量抽屉 ----------

function VarDrawer({
  nodeId,
  vars,
  onChange,
}: {
  nodeId: string;
  vars: PanelVar[];
  onChange: (v: PanelVar[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("0");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s.trim());

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-hairline bg-canvas">
      <div className="flex items-center border-b border-hairline-soft px-3 py-2">
        <p className="text-title-sm text-ink">共享变量</p>
        <span className="ml-2 text-caption text-muted-soft">绑定字段的唯一数据源</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {vars.length === 0 && (
          <p className="py-4 text-center text-caption text-muted">
            还没有变量——在下方新建，然后悬停白板卡片字段点 ⛓ 绑定。
          </p>
        )}
        {vars.map((v) => (
          <div key={v.name} className="mb-1.5 rounded-md bg-surface-soft px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              {renaming === v.name ? (
                <input
                  autoFocus
                  className="h-6 w-28 rounded-xs border border-primary bg-canvas px-1 text-caption text-ink focus:outline-none"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && draftName.trim() && draftName.trim() !== v.name) {
                      try {
                        await invoke("rename_panel_var", {
                          nodeId,
                          oldName: v.name,
                          newName: draftName.trim(),
                        });
                        onChange(
                          vars.map((x) =>
                            x.name === v.name ? { ...x, name: draftName.trim() } : x,
                          ),
                        );
                      } catch (err) {
                        window.alert(String(err));
                      }
                    }
                    setRenaming(null);
                  }}
                />
              ) : (
                <span
                  className="w-28 shrink-0 truncate text-caption text-ink"
                  title="双击重命名（绑定字段同步更新）"
                  onDoubleClick={() => {
                    setRenaming(v.name);
                    setDraftName(v.name);
                  }}
                >
                  {v.name}
                </span>
              )}
              <input
                className="h-7 min-w-0 flex-1 rounded-xs border border-hairline bg-canvas px-1.5 text-caption text-body focus:border-primary focus:outline-none"
                value={v.value}
                onChange={(e) => {
                  const value = e.target.value;
                  onChange(vars.map((x) => (x.name === v.name ? { ...x, value } : x)));
                  void invoke("set_panel_var_value", { nodeId, name: v.name, value }).catch(() => {});
                }}
              />
              <button
                className="shrink-0 rounded-xs px-1 text-[11px] text-muted hover:bg-primary/10 hover:text-error"
                title="删除变量"
                onClick={async () => {
                  try {
                    await invoke("del_panel_var", { nodeId, name: v.name });
                    onChange(vars.filter((x) => x.name !== v.name));
                  } catch (err) {
                    window.alert(String(err));
                  }
                }}
              >
                ✕
              </button>
            </div>
            {isNum(v.value) && (
              <div className="mt-1 flex gap-1">
                {[5, 1, -1, -5].map((d) => (
                  <button
                    key={d}
                    className="h-6 flex-1 rounded-xs text-[11px] font-bold text-primary hover:bg-primary/15"
                    onClick={async () => {
                      const nv = (parseFloat(v.value) || 0) + d;
                      try {
                        await invoke("set_panel_var_value", {
                          nodeId,
                          name: v.name,
                          value: String(nv),
                        });
                        onChange(
                          vars.map((x) => (x.name === v.name ? { ...x, value: String(nv) } : x)),
                        );
                      } catch (err) {
                        window.alert(String(err));
                      }
                    }}
                  >
                    {d > 0 ? `+${d}` : d}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-hairline-soft p-2">
        <div className="flex gap-1.5">
          <input
            className="h-8 w-24 rounded-sm border border-hairline bg-canvas px-1.5 text-caption text-ink focus:border-primary focus:outline-none"
            placeholder="变量名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && setNewName(newName.trim())}
          />
          <input
            className="h-8 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-1.5 text-caption text-ink focus:border-primary focus:outline-none"
            placeholder="初始值"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <button
            className="h-8 shrink-0 rounded-sm bg-primary px-2.5 text-caption text-on-primary hover:bg-primary-active"
            onClick={async () => {
              if (!newName.trim()) return;
              try {
                await invoke("add_panel_var", { nodeId, name: newName.trim(), value: newValue });
                onChange([...vars, { name: newName.trim(), value: newValue }]);
                setNewName("");
                setNewValue("0");
              } catch (err) {
                window.alert(String(err));
              }
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 绑定变量弹窗 ----------

function BindVarDialog({
  vars,
  onCancel,
  onPick,
}: {
  vars: PanelVar[];
  onCancel: () => void;
  onPick: (varName: string) => void;
}) {
  const [newName, setNewName] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onCancel}>
      <div
        className="w-80 rounded-lg bg-canvas p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-title-md text-ink">绑定面板变量</h3>
        <p className="mt-1 text-caption text-muted">该字段的值将实时跟随所选变量。</p>
        <div className="mt-3 max-h-48 overflow-y-auto">
          {vars.length === 0 && <p className="py-3 text-caption text-muted">还没有变量，先在下方新建。</p>}
          {vars.map((v) => (
            <button
              key={v.name}
              className="mb-1 flex h-9 w-full items-center justify-between rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink hover:border-primary hover:text-primary"
              onClick={() => onPick(v.name)}
            >
              <span>{v.name}</span>
              <span className="text-caption text-muted-soft">{v.value}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-1.5 border-t border-hairline-soft pt-3">
          <input
            className="h-8 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink focus:border-primary focus:outline-none"
            placeholder="新建变量名并回车"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) onPick(newName.trim());
            }}
          />
          <button
            className="h-8 shrink-0 rounded-sm bg-primary px-3 text-caption text-on-primary hover:bg-primary-active"
            onClick={() => newName.trim() && onPick(newName.trim())}
          >
            新建并绑定
          </button>
        </div>
      </div>
    </div>
  );
}

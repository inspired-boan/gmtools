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

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;

/** v3 跑团面板白板（M13）：引用树上的卡片，自由摆位 + 缩放平移 */
export default function PanelBoard({ nodeId }: { nodeId: string }) {
  const { nodes, select } = useTree();
  const [items, setItems] = useState<PanelItem[]>([]);
  const [cards, setCards] = useState<Record<string, CachedCard | null>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 60, y: 40 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddList, setShowAddList] = useState(false);

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

  // 加载摆位 + 卡片内容缓存
  const loadBoard = useCallback(async () => {
    try {
      const list = await invoke<PanelItem[]>("get_panel", { nodeId });
      setItems(list);
      // 并发取每张卡的模板与数据（失效引用返回 null）
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
    // 恢复上次视口
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
    return () => {
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
      saveView();
    };
  }, [loadBoard, nodeId, saveView]);

  const addCard = async (cardNodeId: string, x: number, y: number) => {
    try {
      await invoke("set_panel_item", { nodeId, cardNodeId, x, y });
      await loadBoard();
    } catch (e) {
      setError(String(e));
    }
  };

  // ---------- 卡片拖动（本地即时位移，松手落库） ----------
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragCard.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / zoom;
      const dy = (e.clientY - d.startY) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      setItems((list) =>
        list.map((it) =>
          it.cardNodeId === d.cardNodeId
            ? { ...it, x: d.origX + dx, y: d.origY + dy }
            : it,
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
  }, []);

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
    // 以鼠标位置为缩放中心
    setPan((p) => ({
      x: mx - ((mx - p.x) * next) / zoom,
      y: my - ((my - p.y) * next) / zoom,
    }));
    setZoom(next);
    scheduleSaveView();
  };

  // ---------- 树拖入 ----------
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
        <span className="ml-auto text-caption text-muted-soft">
          空白处拖动平移 · Ctrl+滚轮缩放（{Math.round(zoom * 100)}%）· 拖动卡片摆位
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

      {/* 白板 */}
      <div
        ref={viewportRef}
        className="relative flex-1 overflow-hidden bg-surface-soft"
        style={{
          backgroundImage:
            "radial-gradient(circle, #e6dfd8 1px, transparent 1px)",
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          cursor: panDrag.current ? "grabbing" : "default",
        }}
        onWheel={onWheel}
        onMouseDown={(e) => {
          // 空白处按下 → 平移
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
            return (
              <div
                key={it.cardNodeId}
                data-panel-card
                className={`absolute ${dragCard.current?.cardNodeId === it.cardNodeId ? "" : "transition-shadow"}`}
                style={{ left: it.x, top: it.y }}
                onMouseDown={(e) => {
                  // 只响应左键；不抢子元素交互
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
                  const d = dragCard.current;
                  if (d?.moved) return;
                  if (node) select(node.id);
                }}
              >
                {valid ? (
                  <CardRenderer
                    components={cached.tpl.components}
                    data={cached.data}
                    theme={cached.tpl.theme}
                    size={cached.tpl.size}
                    autoHeight={cached.tpl.autoHeight}
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
    </div>
  );
}

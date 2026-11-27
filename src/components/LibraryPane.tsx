import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { childrenOf, useTree } from "../store";
import type { NodeDto, TemplateDto } from "../types";
import CardRenderer from "./CardRenderer";

interface MetaInfo {
  sourceNodeId: string;
  collectedAt: number;
}

interface Preview {
  tpl: TemplateDto;
  data: Record<string, unknown>;
}

/** 单个库项：加载并渲染完整卡面（模板 = 结构骨架；卡片 = 真实数据） */
function LibraryItemCard({
  item,
  meta,
  sourceAlive,
  busy,
  onOpen,
  onSync,
  onTakeOut,
}: {
  item: NodeDto;
  meta: MetaInfo | null;
  sourceAlive: boolean;
  busy: boolean;
  onOpen: () => void;
  onSync: () => void;
  onTakeOut: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        if (item.nodeType === "template") {
          const t = await invoke<TemplateDto>("get_template", { nodeId: item.id });
          setPreview({ tpl: t, data: {} });
        } else {
          const c = await invoke<{ templateId: string; data: Record<string, unknown> } | null>(
            "get_card",
            { nodeId: item.id },
          );
          if (!c) {
            setFailed(true);
            return;
          }
          const t = await invoke<TemplateDto>("get_template", { nodeId: c.templateId });
          setPreview({ tpl: t, data: c.data });
        }
      } catch {
        setFailed(true);
      }
    })();
  }, [item.id, item.nodeType]);

  return (
    <div className="w-fit">
      {/* 信息条 + 操作 */}
      <div className="mb-2 flex w-full items-center gap-2 rounded-md border border-hairline bg-canvas px-3 py-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.nodeType === "template" ? "bg-ink" : "bg-muted"}`}
        />
        <p className="truncate text-title-sm text-ink">{item.name}</p>
        <span className="ml-auto shrink-0 text-caption text-muted-soft">
          {item.nodeType === "template" ? "模板" : "卡片"}
          {meta ? ` · ${new Date(meta.collectedAt).toLocaleDateString("zh-CN")}` : " · 本地创建"}
        </span>
        <button
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-caption text-on-primary hover:bg-primary-active"
          onClick={onOpen}
        >
          打开
        </button>
        {meta && (
          <button
            disabled={busy || !sourceAlive}
            title={sourceAlive ? "同步自来源最新内容" : "来源已被删除"}
            className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-caption text-ink hover:bg-surface-soft disabled:opacity-40"
            onClick={onSync}
          >
            同步
          </button>
        )}
        <button
          disabled={busy}
          title="复制一份到所属规则下"
          className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-caption text-ink hover:bg-surface-soft disabled:opacity-40"
          onClick={onTakeOut}
        >
          取出
        </button>
      </div>

      {/* 完整卡面预览 */}
      {preview ? (
        <CardRenderer
          components={preview.tpl.components}
          data={preview.data}
          theme={preview.tpl.theme}
          size={preview.tpl.size}
          autoHeight={preview.tpl.autoHeight}
        />
      ) : (
        <div
          className="flex h-48 w-full items-center justify-center rounded-lg border border-dashed border-hairline text-caption text-muted-soft"
          style={{ width: 420 }}
        >
          {failed ? "预览加载失败（模板可能已被删除）" : "加载预览中…"}
        </div>
      )}
    </div>
  );
}

/** 模板库 / 卡片库管理界面 */
export default function LibraryPane({ nodeId }: { nodeId: string }) {
  const { nodes, load, select } = useTree();
  const lib = nodes.find((n) => n.id === nodeId);
  const items = childrenOf(nodes, nodeId);
  const [metas, setMetas] = useState<Record<string, MetaInfo | null>>({});
  const [busy, setBusy] = useState(false);

  const loadMetas = useCallback(async () => {
    const entries = await Promise.all(
      items.map(async (it) => {
        try {
          const m = await invoke<MetaInfo | null>("list_library_meta", { itemNodeId: it.id });
          return [it.id, m] as const;
        } catch {
          return [it.id, null] as const;
        }
      }),
    );
    setMetas(Object.fromEntries(entries));
  }, [items]);

  useEffect(() => {
    loadMetas();
  }, [loadMetas]);

  if (!lib) return <div className="p-6 text-body-sm text-error">库节点不存在</div>;

  const sourceAlive = (m: MetaInfo | null) => !!m && nodes.some((n) => n.id === m.sourceNodeId);

  const sync = async (item: NodeDto) => {
    setBusy(true);
    try {
      await invoke("sync_from_source", { itemNodeId: item.id });
      await load();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  const takeOut = async (item: NodeDto) => {
    // 取出 = 复制到库的父节点（规则层）
    setBusy(true);
    try {
      await invoke("copy_node", {
        id: item.id,
        newParentId: lib.parentId,
        newName: `${item.name} (取出)`,
      });
      await load();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-hairline-soft px-4 py-2">
        <p className="text-title-sm text-ink">
          {lib.nodeType === "tplLib" ? "模板库" : "卡片库"} · {lib.name}
        </p>
        <span className="ml-3 text-caption text-muted-soft">
          {lib.nodeType === "tplLib"
            ? "收藏的模板在此规则内创建卡片时可直接选用"
            : "收藏的卡片含数据与模板，可整张复制复用"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto bg-surface-soft p-4">
        {items.length === 0 ? (
          <p className="py-10 text-center text-body-sm text-muted">
            库还是空的——在模板/卡片节点上右键「收藏到库」，或点对应编辑器顶部的收藏按钮。
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-6">
            {items.map((it) => {
              const m = metas[it.id] ?? null;
              return (
                <LibraryItemCard
                  key={it.id}
                  item={it}
                  meta={m}
                  sourceAlive={sourceAlive(m)}
                  busy={busy}
                  onOpen={() => select(it.id)}
                  onSync={() => void sync(it)}
                  onTakeOut={() => void takeOut(it)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

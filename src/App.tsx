import { useEffect } from "react";
import { Tree } from "./components/Tree";
import { childrenOf, useTree } from "./store";

/**
 * 主界面：左侧树导航 + 右侧内容区。
 * 里程碑 3：树可用；内容区按选中节点类型显示占位。
 */
export default function App() {
  const { nodes, selectedId, load, createNode } = useTree();
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full">
      {/* 左侧栏 */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-hairline bg-canvas">
        <div className="p-3">
          <input
            type="text"
            placeholder="搜索笔记和表格…"
            className="h-10 w-full rounded-md border border-hairline bg-canvas px-3.5 text-body-sm text-ink placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15"
          />
        </div>

        <div className="px-3 pb-1">
          <button
            className="h-9 w-full rounded-md bg-primary px-3 text-body-sm text-on-primary hover:bg-primary-active"
            onClick={() => createNode(null, "label", "新规则")}
          >
            + 新建规则
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto py-1"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("[data-tree-node]")) return;
            e.preventDefault();
          }}
        >
          <Tree />
        </div>

        <div className="border-t border-hairline-soft p-3">
          <div className="flex gap-2">
            <button className="h-9 flex-1 rounded-md border border-hairline bg-canvas px-3 text-caption text-ink hover:bg-surface-soft">
              回收站
            </button>
            <button className="h-9 flex-1 rounded-md border border-hairline bg-canvas px-3 text-caption text-ink hover:bg-surface-soft">
              设置
            </button>
          </div>
        </div>
      </aside>

      {/* 右侧内容区 */}
      <main className="flex flex-1 flex-col items-center justify-center bg-canvas">
        {selected ? (
          <div className="text-center">
            <p className="text-caption text-muted-soft">
              {selected.nodeType === "label" ? "标签" : selected.nodeType === "note" ? "笔记" : "表格"}
            </p>
            <h1 className="mt-1 font-display text-display-sm text-ink">{selected.name}</h1>
            <p className="mt-3 text-body-sm text-muted">
              {selected.nodeType === "note"
                ? "笔记编辑器在里程碑 4 接入"
                : selected.nodeType === "table"
                  ? "表格编辑在里程碑 5 接入"
                  : `包含 ${childrenOf(nodes, selected.id).length} 个子节点`}
            </p>
          </div>
        ) : (
          <div className="text-center">
            <h1 className="font-display text-display-md text-ink">GM 工具</h1>
            <p className="mt-2 text-body-md text-muted">
              从左侧选择一个节点，或新建规则开始备团
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

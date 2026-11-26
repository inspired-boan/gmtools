import { useEffect, useState } from "react";
import CardPane from "./components/CardPane";
import GridView from "./components/GridView";
import NoteEditor from "./components/NoteEditor";
import SearchBox from "./components/SearchBox";
import SettingsModal from "./components/SettingsModal";
import TemplateEditor from "./components/TemplateEditor";
import TrashModal from "./components/TrashModal";
import { Tree } from "./components/Tree";
import { childrenOf, useTree } from "./store";

/**
 * 主界面：左侧树导航 + 右侧内容区。
 * 里程碑 3：树可用；内容区按选中节点类型显示占位。
 */
export default function App() {
  const { nodes, selectedId, load, createNode } = useTree();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full">
      {/* 左侧栏 */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-hairline bg-canvas">
        <SearchBox />

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
            <button
              className="h-9 flex-1 rounded-md border border-hairline bg-canvas px-3 text-caption text-ink hover:bg-surface-soft"
              onClick={() => setTrashOpen(true)}
            >
              回收站
            </button>
            <button
              className="h-9 flex-1 rounded-md border border-hairline bg-canvas px-3 text-caption text-ink hover:bg-surface-soft"
              onClick={() => setSettingsOpen(true)}
            >
              设置
            </button>
          </div>
        </div>
      </aside>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}

      {/* 右侧内容区 */}
      <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
        {selected ? (
          selected.nodeType === "note" ? (
            <NoteEditor key={selected.id} nodeId={selected.id} />
          ) : selected.nodeType === "table" ? (
            <GridView key={selected.id} nodeId={selected.id} />
          ) : selected.nodeType === "template" ? (
            <TemplateEditor key={selected.id} nodeId={selected.id} />
          ) : selected.nodeType === "card" ? (
            <CardPane key={selected.id} nodeId={selected.id} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center">
              <div className="text-center">
                <p className="text-caption text-muted-soft">标签</p>
                <h1 className="mt-1 font-display text-display-sm text-ink">{selected.name}</h1>
                <p className="mt-3 text-body-sm text-muted">
                  包含 {childrenOf(nodes, selected.id).length} 个子节点
                </p>
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <h1 className="font-display text-display-md text-ink">GM 工具</h1>
              <p className="mt-2 text-body-md text-muted">
                从左侧选择一个节点，或新建规则开始备团
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

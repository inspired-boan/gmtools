import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { childrenOf, subtreeCount, useTree } from "../store";
import type { NodeDto, NodeType } from "../types";

/** 类型圆点：label 珊瑚 / note 青绿 / table 琥珀 / template 墨色 / card 灰 */
const DOT: Record<NodeType, string> = {
  label: "bg-primary",
  note: "bg-accent-teal",
  table: "bg-accent-amber",
  template: "bg-ink",
  card: "bg-muted",
};

export function Tree() {
  const { nodes, loaded, load, expanded, selectedId, select, toggleExpand } = useTree();
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeDto | null } | null>(null);
  /** 右键菜单触发的重命名：Tree 层持有 id，对应行直接进入编辑态 */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  useEffect(() => {
    const close = () => setMenu(null);
    if (menu) {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("contextmenu", close);
      };
    }
  }, [menu]);

  if (!loaded) {
    return <div className="p-4 text-caption text-muted-soft">加载中…</div>;
  }

  const roots = childrenOf(nodes, null);
  return (
    <div className="select-none">
      {roots.length === 0 && (
        <div className="px-3 py-6 text-center text-caption text-muted">
          还没有规则。右键此处或点击「新建规则」开始。
        </div>
      )}
      {roots.map((n) => (
        <TreeNodeRow
          key={n.id}
          node={n}
          depth={0}
          expanded={expanded}
          selectedId={selectedId}
          renamingId={renamingId}
          onRenameDone={() => setRenamingId(null)}
          onStartRename={(id) => setRenamingId(id)}
          onSelect={select}
          onToggle={toggleExpand}
          onContextMenu={(x, y, node) => setMenu({ x, y, node })}
        />
      ))}
      {menu && (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          onClose={() => setMenu(null)}
          onStartRename={(id) => setRenamingId(id)}
        />
      )}
    </div>
  );
}

// ---------- 单行节点 ----------

interface RowProps {
  node: NodeDto;
  depth: number;
  expanded: Record<string, boolean>;
  selectedId: string | null;
  renamingId: string | null;
  onRenameDone: () => void;
  onStartRename: (id: string) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onContextMenu: (x: number, y: number, node: NodeDto) => void;
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  selectedId,
  renamingId,
  onRenameDone,
  onStartRename,
  onSelect,
  onToggle,
  onContextMenu,
}: RowProps) {
  const { nodes, renameNode, moveNode } = useTree();
  const [draftName, setDraftName] = useState(node.name);
  const [dropZone, setDropZone] = useState<"before" | "inside" | "after" | null>(null);
  const isOpen = !!expanded[node.id];
  const children = childrenOf(nodes, node.id);
  const hasChildren = children.length > 0;
  const renaming = renamingId === node.id;

  // 进入编辑态时（无论双击还是右键菜单触发）同步草稿名
  useEffect(() => {
    if (renaming) setDraftName(node.name);
  }, [renaming, node.name]);

  const commitRename = async () => {
    const name = draftName.trim();
    onRenameDone();
    if (name && name !== node.name) {
      await renameNode(node.id, name);
    } else {
      setDraftName(node.name);
    }
  };

  // 拖拽：上 1/4 → 插到其前，下 1/4 → 插到其后，中间 → 作为其子节点（尾部追加）
  const handleDrop = async (e: React.DragEvent, zone: "before" | "inside" | "after") => {
    e.preventDefault();
    e.stopPropagation();
    setDropZone(null);
    const dragId = e.dataTransfer.getData("text/gm-node");
    if (!dragId || dragId === node.id) return;
    if (zone === "inside") {
      await moveNode(dragId, node.id, children.length);
    } else {
      const siblings = childrenOf(nodes, node.parentId);
      let idx = siblings.findIndex((s) => s.id === node.id);
      if (zone === "after") idx += 1;
      // 后端会剔除自身再按位置取 sort_order，这里直接传目标序号
      await moveNode(dragId, node.parentId, Math.max(0, idx));
    }
  };

  return (
    <div>
      <div
        data-tree-node
        className={`group mx-1 flex h-8 cursor-default items-center gap-1 rounded-md px-1 ${
          selectedId === node.id ? "bg-surface-cream-strong" : "hover:bg-surface-soft"
        } ${dropZone === "inside" ? "bg-surface-card ring-1 ring-primary/40" : ""}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => {
          setDraftName(node.name);
          onRenameDone();
          onStartRename(node.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(node.id);
          onContextMenu(e.clientX, e.clientY, node);
        }}
        draggable={!renaming}
        onDragStart={(e) => e.dataTransfer.setData("text/gm-node", node.id)}
        onDragOver={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const rel = (e.clientY - r.top) / r.height;
          setDropZone(rel < 0.25 ? "before" : rel > 0.75 ? "after" : "inside");
        }}
        onDragLeave={() => setDropZone(null)}
        onDrop={(e) => {
          const zone = dropZone ?? "inside";
          handleDrop(e, zone);
        }}
      >
        {/* 展开/折叠箭头 */}
        <button
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-[10px] text-muted ${
            hasChildren ? "opacity-100" : "opacity-0"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
        >
          {isOpen ? "▼" : "▶"}
        </button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[node.nodeType]}`} />
        {renaming ? (
          <input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className="h-6 w-full min-w-0 rounded-xs border border-primary bg-canvas px-1 text-body-sm text-ink focus:outline-none"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                onRenameDone();
                setDraftName(node.name);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate text-body-sm text-ink">{node.name}</span>
        )}
      </div>

      {/* 插入位置指示线 */}
      {(dropZone === "before" || dropZone === "after") && (
        <div
          className={`mx-3 h-0.5 rounded-full bg-primary ${dropZone === "before" ? "-mt-2" : "-mt-0.5"}`}
        />
      )}

      {isOpen &&
        children.map((c) => (
          <TreeNodeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            selectedId={selectedId}
            renamingId={renamingId}
            onRenameDone={onRenameDone}
            onStartRename={onStartRename}
            onSelect={onSelect}
            onToggle={onToggle}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  );
}

// ---------- 右键菜单 ----------

function NodeMenu({
  x,
  y,
  node,
  onClose,
  onStartRename,
}: {
  x: number;
  y: number;
  node: NodeDto | null;
  onClose: () => void;
  onStartRename: (id: string) => void;
}) {
  const { createNode, copyNode, deleteNode } = useTree();
  const [sub, setSub] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { nodes } = useTree();
  const ref = useRef<HTMLDivElement>(null);

  if (!node) {
    // 空白处右键 / 根级：只提供新建规则
    return (
      <div
        ref={ref}
        className="fixed z-50 w-44 rounded-lg border border-hairline bg-canvas py-1 shadow-lg"
        style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 120) }}
      >
        <MenuItem
          label="新建规则"
          onClick={async () => {
            await createNode(null, "label", "新规则");
            onClose();
          }}
        />
      </div>
    );
  }

  if (confirming) {
    return (
      <ConfirmDelete
        count={subtreeCount(nodes, node.id)}
        name={node.name}
        onCancel={onClose}
        onConfirm={async () => {
          await deleteNode(node.id);
          onClose();
        }}
      />
    );
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 w-48 rounded-lg border border-hairline bg-canvas py-1 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 260) }}
    >
      <div className="relative" onMouseEnter={() => setSub(true)} onMouseLeave={() => setSub(false)}>
        <MenuItem label="新建子节点" trailing={sub ? "" : "▸"} />
        {sub && (
          <div className="absolute left-full top-0 -ml-1 w-36 rounded-lg border border-hairline bg-canvas py-1 shadow-lg">
            {(["label", "note", "table", "template", "card"] as NodeType[]).map((t) => (
              <MenuItem
                key={t}
                label={t === "label" ? "标签" : t === "note" ? "笔记" : t === "table" ? "表格" : t === "template" ? "模板" : "卡片"}
                onClick={async () => {
                  const names: Record<NodeType, string> = {
                    label: "新标签",
                    note: "新笔记",
                    table: "新表格",
                    template: "新模板",
                    card: "新卡片",
                  };
                  await createNode(node.id, t, names[t]);
                  onClose();
                }}
              />
            ))}
          </div>
        )}
      </div>
      <MenuItem
        label="复制（含子节点）"
        onClick={async () => {
          await copyNode(node.id, node.parentId, `${node.name} (副本)`);
          onClose();
        }}
      />
      <MenuItem
        label="导出节点"
        onClick={async () => {
          onClose();
          const path = await saveDialog({
            title: "导出节点",
            defaultPath: `${node.name}.gmnode.json`,
            filters: [{ name: "GM工具节点", extensions: ["json"] }],
          });
          if (!path) return;
          try {
            await invoke("export_node", { nodeId: node.id, path });
          } catch (e) {
            window.alert(`导出失败: ${e}`);
          }
        }}
      />
      <MenuItem
        label="导入节点到此处"
        onClick={async () => {
          onClose();
          const path = await openDialog({
            title: "导入节点",
            multiple: false,
            directory: false,
            filters: [{ name: "GM工具节点", extensions: ["json"] }],
          });
          if (!path) return;
          try {
            await invoke("import_node", { path, parentId: node.id });
            await useTree.getState().load();
          } catch (e) {
            window.alert(`导入失败: ${e}`);
          }
        }}
      />
      <MenuItem
        label="重命名"
        onClick={() => {
          onClose();
          onStartRename(node.id);
        }}
      />
      <div className="my-1 border-t border-hairline-soft" />
      <MenuItem
        label="删除"
        danger
        onClick={() => setConfirming(true)}
      />
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  trailing,
}: {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  trailing?: string;
}) {
  return (
    <button
      className={`flex h-8 w-full items-center justify-between px-3 text-left text-body-sm hover:bg-surface-soft ${
        danger ? "text-error" : "text-ink"
      }`}
      onClick={onClick}
    >
      <span>{label}</span>
      {trailing && <span className="text-muted-soft">{trailing}</span>}
    </button>
  );
}

function ConfirmDelete({
  name,
  count,
  onConfirm,
  onCancel,
}: {
  name: string;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onCancel}>
      <div
        className="w-96 rounded-lg bg-canvas p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-title-md text-ink">确认删除</h3>
        <p className="mt-2 text-body-sm text-body">
          将删除 <span className="font-medium text-ink">「{name}」</span>
          {count > 1 && (
            <>
              {" "}及其子树（含 <span className="font-medium text-ink">{count - 1}</span> 个子节点）
            </>
          )}
          ，并移入回收站。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="h-10 rounded-md border border-hairline bg-canvas px-4 text-body-sm text-ink hover:bg-surface-soft"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="h-10 rounded-md bg-primary px-4 text-body-sm text-on-primary hover:bg-primary-active"
            onClick={onConfirm}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

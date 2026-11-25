import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { NodeDto, NodeType } from "./types";

interface TreeState {
  nodes: NodeDto[];
  loaded: boolean;
  selectedId: string | null;
  expanded: Record<string, boolean>;

  load: () => Promise<void>;
  select: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setExpanded: (id: string, v: boolean) => void;

  createNode: (parentId: string | null, type: NodeType, name: string) => Promise<NodeDto>;
  renameNode: (id: string, name: string) => Promise<void>;
  moveNode: (id: string, newParentId: string | null, index: number) => Promise<void>;
  copyNode: (id: string, newParentId: string | null, newName: string | null) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
}

export const useTree = create<TreeState>((set, get) => ({
  nodes: [],
  loaded: false,
  selectedId: null,
  expanded: {},

  load: async () => {
    const nodes = await invoke<NodeDto[]>("get_tree");
    set({ nodes, loaded: true });
  },

  select: (id) => set({ selectedId: id }),
  toggleExpand: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),

  createNode: async (parentId, type, name) => {
    const node = await invoke<NodeDto>("create_node", {
      parentId,
      nodeType: type,
      name,
    });
    await get().load();
    if (parentId) get().setExpanded(parentId, true);
    get().select(node.id);
    return node;
  },

  renameNode: async (id, name) => {
    await invoke("rename_node", { id, name });
    await get().load();
  },

  moveNode: async (id, newParentId, index) => {
    await invoke("move_node", { id, newParentId, index });
    await get().load();
  },

  copyNode: async (id, newParentId, newName) => {
    const node = await invoke<NodeDto>("copy_node", { id, newParentId, newName });
    await get().load();
    if (newParentId) get().setExpanded(newParentId, true);
    get().select(node.id);
  },

  deleteNode: async (id) => {
    await invoke("delete_node", { id });
    if (get().selectedId === id) set({ selectedId: null });
    await get().load();
  },
}));

/** 按 parentId 取直接子节点（已按 sortOrder 排序；后端保证有序） */
export function childrenOf(nodes: NodeDto[], parentId: string | null): NodeDto[] {
  return nodes.filter((n) => n.parentId === parentId);
}

/** 统计子树规模（删除确认用） */
export function subtreeCount(nodes: NodeDto[], id: string): number {
  let n = 1;
  for (const c of childrenOf(nodes, id)) n += subtreeCount(nodes, c.id);
  return n;
}

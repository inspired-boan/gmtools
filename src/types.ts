export type NodeType = "label" | "note" | "table" | "template" | "card";
export type ColType = "text" | "markdown";

// ---------- v2 卡片/模板 ----------

export type ComponentType = "text" | "markdown" | "number" | "dropdown" | "image" | "group" | "style";

export interface ComponentStyle {
  color?: string;
  fontSize?: string;
}

export interface ComponentDef {
  id: string;
  type: ComponentType;
  label: string;
  placeholder?: string;
  default?: string | number;
  required?: boolean;
  span: number; // 1~12
  options?: string[]; // dropdown 专用
  children?: ComponentDef[]; // group 专用（一层）
  style?: ComponentStyle;
}

export type CardSize = "npc" | "item" | "art";
export type CardThemeKey = "cream" | "dark" | "coral" | "forest" | "parchment";

export interface TemplateDto {
  nodeId: string;
  ruleId: string | null;
  size: CardSize;
  theme: CardThemeKey;
  autoHeight: boolean;
  components: ComponentDef[];
}

/** 卡片尺寸预设（px，设计基准，渲染时可缩放） */
export const CARD_SIZES: Record<CardSize, { w: number; h: number; name: string }> = {
  npc: { w: 420, h: 595, name: "NPC 竖卡" },
  item: { w: 595, h: 420, name: "物品横卡" },
  art: { w: 760, h: 570, name: "全宽立绘" },
};

/** 主题预设 → 卡片渲染 CSS 变量（取自 DESIGN-claude.md 色板） */
export const CARD_THEMES: Record<
  CardThemeKey,
  { name: string; bg: string; ink: string; muted: string; accent: string; border: string; surface: string }
> = {
  cream: { name: "素雅", bg: "#faf9f5", ink: "#141413", muted: "#6c6a64", accent: "#cc785c", border: "#e6dfd8", surface: "#efe9de" },
  dark: { name: "暗夜", bg: "#181715", ink: "#faf9f5", muted: "#a09d96", accent: "#5db8a6", border: "#252320", surface: "#1f1e1b" },
  coral: { name: "珊瑚", bg: "#faf9f5", ink: "#141413", muted: "#6c6a64", accent: "#cc785c", border: "#cc785c", surface: "#f5e8e0" },
  forest: { name: "墨林", bg: "#1f2a24", ink: "#eaf2ee", muted: "#8ba79a", accent: "#5db8a6", border: "#2c3a32", surface: "#26332c" },
  parchment: { name: "羊皮纸", bg: "#e8e0d2", ink: "#3d3428", muted: "#7a6d58", accent: "#a9583e", border: "#c9bda6", surface: "#efe9de" },
};

export interface NodeDto {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ColDto {
  id: string;
  name: string;
  colType: ColType;
  width: number | null;
  sortOrder: number;
}

export interface RowDto {
  id: string;
  sortOrder: number;
}

export interface CellDto {
  rowId: string;
  colId: string;
  value: string | null;
}

export interface GridDto {
  cols: ColDto[];
  rows: RowDto[];
  cells: CellDto[];
}

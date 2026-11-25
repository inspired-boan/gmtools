export type NodeType = "label" | "note" | "table";
export type ColType = "text" | "markdown";

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

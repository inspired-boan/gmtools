export type NodeType = "label" | "note" | "table";

export interface NodeDto {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

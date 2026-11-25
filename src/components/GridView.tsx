import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CellDto, ColDto, GridDto } from "../types";

/**
 * 表格节点视图（里程碑 5）。
 * 列类型：text（点击即编）/ markdown（浮层编辑）。
 * 所有变更即时落库（onBlur / 操作完成即 invoke）。
 */

const DEFAULT_COL_WIDTH = 160;
const HEADER_HEIGHT = 40;

export default function GridView({ nodeId }: { nodeId: string }) {
  const [grid, setGrid] = useState<GridDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mdEdit, setMdEdit] = useState<{ rowId: string; colId: string; value: string } | null>(null);
  const [menu, setMenu] = useState<
    | { kind: "col"; x: number; y: number; col: ColDto }
    | { kind: "row"; x: number; y: number; rowIndex: number; rowId: string }
    | null
  >(null);
  const resizing = useRef<{ colId: string; startX: number; startW: number } | null>(null);
  /** 脏单元格：输入即标记，失焦/卸载时冲刷，避免丢失编辑 */
  const dirty = useRef(new Map<string, { rowId: string; colId: string; value: string | null }>());

  const reload = useCallback(async () => {
    try {
      const g = await invoke<GridDto>("get_grid", { nodeId });
      // 合并尚未落库的编辑，避免刷新吞掉正在输入的内容
      const cells = [...g.cells];
      for (const c of dirty.current.values()) {
        const i = cells.findIndex((x) => x.rowId === c.rowId && x.colId === c.colId);
        if (i >= 0) cells[i] = { ...cells[i], value: c.value };
        else cells.push({ rowId: c.rowId, colId: c.colId, value: c.value });
      }
      setGrid({ ...g, cells });
    } catch (e) {
      setError(String(e));
    }
  }, [nodeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 卸载前冲刷所有未保存单元格
  useEffect(() => {
    return () => {
      for (const c of dirty.current.values()) {
        void invoke("set_cell", c).catch(() => {});
      }
      dirty.current.clear();
    };
  }, []);

  const saveCell = (rowId: string, colId: string, value: string | null) => {
    dirty.current.delete(`${rowId}:${colId}`);
    updateCellLocal(rowId, colId, value);
    void invoke("set_cell", { rowId, colId, value }).catch((e) => setError(String(e)));
  };

  // 全局关闭右键菜单（菜单内部点击除外）+ 列宽拖拽
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-grid-menu]")) return;
      setMenu(null);
    };
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const dx = e.clientX - resizing.current.startX;
      const w = Math.max(60, resizing.current.startW + dx);
      // 本地即时反馈；结束才落库
      setGrid((g) =>
        g
          ? {
              ...g,
              cols: g.cols.map((c) =>
                c.id === resizing.current!.colId ? { ...c, width: w } : c,
              ),
            }
          : g,
      );
    };
    const up = () => {
      if (!resizing.current) return;
      const { colId } = resizing.current;
      resizing.current = null;
      setGrid((g) => {
        const col = g?.cols.find((c) => c.id === colId);
        if (col?.width) {
          void invoke("set_col_width", { colId, width: col.width }).catch((e) =>
            setError(String(e)),
          );
        }
        return g;
      });
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  if (error) return <div className="p-6 text-body-sm text-error">{error}</div>;
  if (!grid) return <div className="p-6 text-body-sm text-muted-soft">加载中…</div>;

  const cellValue = (rowId: string, colId: string): string | null =>
    grid.cells.find((c) => c.rowId === rowId && c.colId === colId)?.value ?? null;

  const updateCellLocal = (rowId: string, colId: string, value: string | null) => {
    setGrid((g) => {
      if (!g) return g;
      const exists = g.cells.some((c) => c.rowId === rowId && c.colId === colId);
      const cells: CellDto[] = exists
        ? g.cells.map((c) => (c.rowId === rowId && c.colId === colId ? { ...c, value } : c))
        : [...g.cells, { rowId, colId, value }];
      return { ...g, cells };
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <table className="border-collapse" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th
                className="sticky top-0 z-10 w-10 border border-hairline bg-surface-soft text-caption font-medium text-muted"
                style={{ height: HEADER_HEIGHT }}
              >
                #
              </th>
              {grid.cols.map((col, i) => (
                <th
                  key={col.id}
                  className="group sticky top-0 z-10 border border-hairline bg-surface-soft p-0 text-left"
                  style={{ width: col.width ?? DEFAULT_COL_WIDTH, height: HEADER_HEIGHT }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ kind: "col", x: e.clientX, y: e.clientY, col });
                  }}
                >
                  <div className="flex h-full items-center px-3">
                    <span className="truncate text-title-sm text-ink">{col.name}</span>
                    <span
                      className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                        col.colType === "markdown" ? "bg-accent-teal" : "bg-muted-soft"
                      }`}
                      title={col.colType === "markdown" ? "markdown 列（双击编辑）" : "文本列"}
                    />
                  </div>
                  {/* 列宽拖拽条 */}
                  <div
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/30"
                    onMouseDown={(e) => {
                      resizing.current = {
                        colId: col.id,
                        startX: e.clientX,
                        startW: col.width ?? DEFAULT_COL_WIDTH,
                      };
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  />
                  {i === grid.cols.length - 1 && (
                    <button
                      className="absolute top-1/2 -translate-y-1/2 right-2 flex h-6 w-6 items-center justify-center rounded-sm text-muted opacity-0 group-hover:opacity-100 hover:bg-canvas"
                      style={{ right: -28 }}
                      title="新增列"
                      onClick={async () => {
                        await invoke("add_col", { nodeId, name: "新列", colType: "text" });
                        await reload();
                      }}
                    >
                      +
                    </button>
                  )}
                </th>
              ))}
              {grid.cols.length === 0 && (
                <th
                  className="sticky top-0 z-10 border border-hairline bg-surface-soft text-caption text-muted"
                  style={{ height: HEADER_HEIGHT, width: 300 }}
                >
                  右键此处或点 + 新增列
                  <button
                    className="ml-2 rounded-sm bg-canvas px-1.5 hover:bg-surface-card"
                    onClick={async () => {
                      await invoke("add_col", { nodeId, name: "新列", colType: "text" });
                      await reload();
                    }}
                  >
                    +
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, ri) => (
              <tr key={row.id} className="group/row">
                <td
                  className="relative border border-hairline bg-canvas text-center text-caption text-muted-soft"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ kind: "row", x: e.clientX, y: e.clientY, rowIndex: ri, rowId: row.id });
                  }}
                >
                  {ri + 1}
                </td>
                {grid.cols.map((col) => {
                  const v = cellValue(row.id, col.id);
                  return (
                    <td key={col.id} className="border border-hairline p-0 align-top">
                      {col.colType === "text" ? (
                        <input
                          className="h-8 w-full bg-transparent px-3 text-body-sm text-body focus:bg-canvas focus:outline-none focus:ring-1 focus:ring-primary/40"
                          value={v ?? ""}
                          onChange={(e) => {
                            updateCellLocal(row.id, col.id, e.target.value);
                            dirty.current.set(`${row.id}:${col.id}`, {
                              rowId: row.id,
                              colId: col.id,
                              value: e.target.value === "" ? null : e.target.value,
                            });
                          }}
                          onBlur={() => {
                            // 以脏标记为准：onChange 与 blur 的值恒等，不能用 v 比较
                            const pending = dirty.current.get(`${row.id}:${col.id}`);
                            if (pending) saveCell(pending.rowId, pending.colId, pending.value);
                          }}
                        />
                      ) : (
                        <div
                          className="min-h-8 cursor-text px-3 py-1.5 text-body-sm text-body hover:bg-surface-soft"
                          onDoubleClick={() =>
                            setMdEdit({ rowId: row.id, colId: col.id, value: v ?? "" })
                          }
                          title="双击打开 markdown 编辑"
                        >
                          <span className="line-clamp-3 whitespace-pre-wrap">{v ?? ""}</span>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="mt-2 h-8 rounded-md border border-dashed border-hairline px-3 text-caption text-muted hover:border-primary hover:text-primary"
          onClick={async () => {
            await invoke("add_row", { nodeId });
            await reload();
          }}
        >
          + 新增行
        </button>
      </div>

      {/* markdown 单元格浮层编辑器 */}
      {mdEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={() => setMdEdit(null)}>
          <div
            className="flex w-[560px] max-w-[90vw] flex-col rounded-lg bg-canvas shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-hairline-soft px-4 py-2 text-title-sm text-ink">
              编辑单元格（markdown）
            </div>
            <textarea
              autoFocus
              className="h-48 w-full resize-none bg-canvas px-4 py-3 font-code text-body-sm text-body focus:outline-none"
              value={mdEdit.value}
              onChange={(e) => setMdEdit({ ...mdEdit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMdEdit(null);
              }}
            />
            <div className="flex justify-end gap-2 border-t border-hairline-soft p-3">
              <button
                className="h-9 rounded-md border border-hairline bg-canvas px-4 text-body-sm text-ink hover:bg-surface-soft"
                onClick={() => setMdEdit(null)}
              >
                取消
              </button>
              <button
                className="h-9 rounded-md bg-primary px-4 text-body-sm text-on-primary hover:bg-primary-active"
                onClick={() => {
                  const val = mdEdit.value.trim();
                  saveCell(mdEdit.rowId, mdEdit.colId, val === "" ? null : val);
                  setMdEdit(null);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {menu && (
        <GridMenu menu={menu} nodeId={nodeId} reload={reload} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function GridMenu({
  menu,
  nodeId,
  reload,
  onClose,
}: {
  menu:
    | { kind: "col"; x: number; y: number; col: ColDto }
    | { kind: "row"; x: number; y: number; rowIndex: number; rowId: string };
  nodeId: string;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(menu.kind === "col" ? menu.col.name : "");

  const item = (label: string, onClick: () => void, danger?: boolean, autoClose = true) => (
    <button
      className={`h-8 w-full px-3 text-left text-body-sm hover:bg-surface-soft ${
        danger ? "text-error" : "text-ink"
      }`}
      onClick={() => {
        onClick();
        if (autoClose) onClose();
      }}
    >
      {label}
    </button>
  );

  let content;
  if (menu.kind === "col") {
    const col = menu.col;
    if (renaming) {
      content = (
        <div className="p-2">
          <input
            autoFocus
            className="h-8 w-full rounded-sm border border-primary px-2 text-body-sm text-ink focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && name.trim()) {
                await invoke("rename_col", { colId: col.id, name: name.trim() });
                await reload();
                setRenaming(false);
                onClose();
              }
            }}
          />
        </div>
      );
    } else {
      content = (
        <>
          {item("左侧插入列", async () => {
            const g = await invoke<GridDto>("get_grid", { nodeId });
            const idx = g.cols.findIndex((c) => c.id === col.id);
            await invoke("add_col", { nodeId, name: "新列", colType: "text", index: idx });
            await reload();
          })}
          {item("右侧插入列", async () => {
            const g = await invoke<GridDto>("get_grid", { nodeId });
            const idx = g.cols.findIndex((c) => c.id === col.id);
            await invoke("add_col", { nodeId, name: "新列", colType: "text", index: idx + 1 });
            await reload();
          })}
          {item(
            "重命名",
            () => {
              setName(col.name);
              setRenaming(true);
            },
            false,
            false,
          )}
          <div className="my-1 border-t border-hairline-soft" />
          {item("删除列", async () => {
            await invoke("del_col", { colId: col.id });
            await reload();
          }, true)}
        </>
      );
    }
  } else {
    const { rowId, rowIndex } = menu;
    content = (
      <>
        {item("上方插入行", async () => {
          await invoke("add_row", { nodeId, index: rowIndex });
          await reload();
        })}
        {item("下方插入行", async () => {
          await invoke("add_row", { nodeId, index: rowIndex + 1 });
          await reload();
        })}
        <div className="my-1 border-t border-hairline-soft" />
        {item("删除行", async () => {
          await invoke("del_row", { rowId });
          await reload();
        }, true)}
      </>
    );
  }

  return (
    <div
      data-grid-menu
      className="fixed z-50 w-40 rounded-lg border border-hairline bg-canvas py-1 shadow-lg"
      style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 220) }}
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </div>
  );
}

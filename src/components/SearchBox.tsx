import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTree } from "../store";
import type { NodeDto } from "../types";

interface SearchResult {
  refType: "node" | "note" | "cell";
  refId: string;
  nodeId: string;
  nodeName: string;
  snippet: string; // FTS 路径带 << >> 高亮标记；LIKE/节点名路径为纯片段
}

/** 片段高亮：优先用 << >> 标记，否则按关键词匹配切分 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (text.includes("<<") && text.includes(">>")) {
    const parts = text.split(/<<|>>/);
    return (
      <>
        {parts.map((p, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="rounded-xs bg-accent-amber/40 px-0.5 text-ink">{p}</mark>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </>
    );
  }
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let pos = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx >= 0 && key < 20) {
    if (idx > pos) out.push(<span key={key++}>{text.slice(pos, idx)}</span>);
    out.push(
      <mark key={key++} className="rounded-xs bg-accent-amber/40 px-0.5 text-ink">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    pos = idx + q.length;
    idx = lower.indexOf(q, pos);
  }
  out.push(<span key={key++}>{text.slice(pos)}</span>);
  return <>{out}</>;
}

export default function SearchBox() {
  const { nodes, select, setExpanded } = useTree();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await invoke<SearchResult[]>("search", { query: query.trim() });
        setResults(r);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query]);

  // 点击面板外关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const jump = (nodeId: string) => {
    // 展开祖先链，让树里能看到该节点
    const byId = new Map<string, NodeDto>(nodes.map((n) => [n.id, n]));
    let cur = byId.get(nodeId);
    const chain: string[] = [];
    while (cur?.parentId) {
      chain.push(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    for (const id of chain) setExpanded(id, true);
    select(nodeId);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative p-3 pb-1">
      <input
        type="text"
        placeholder="搜索笔记和表格…"
        className="h-10 w-full rounded-md border border-hairline bg-canvas px-3.5 text-body-sm text-ink placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="absolute inset-x-3 top-13 z-40 max-h-96 overflow-y-auto rounded-lg border border-hairline bg-canvas shadow-lg">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-caption text-muted">没有匹配的结果</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.refId}-${i}`}
                className="block w-full border-b border-hairline-soft px-4 py-2 text-left last:border-0 hover:bg-surface-soft"
                onClick={() => jump(r.nodeId)}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      r.refType === "node"
                        ? "bg-primary"
                        : r.refType === "note"
                          ? "bg-accent-teal"
                          : "bg-accent-amber"
                    }`}
                  />
                  <span className="truncate text-title-sm text-ink">
                    {r.refType === "node" ? (
                      <Highlight text={r.nodeName} query={query.trim()} />
                    ) : (
                      r.nodeName
                    )}
                  </span>
                  <span className="ml-auto shrink-0 text-caption text-muted-soft">
                    {r.refType === "node" ? "节点" : r.refType === "note" ? "笔记" : "表格"}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-caption text-muted">
                  <Highlight text={r.snippet} query={query.trim()} />
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

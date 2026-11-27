import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface LibraryBrief {
  nodeId: string;
  name: string;
  ruleName: string | null;
}

/** 收藏到库对话框：列出全部同类库（按规则分组），点击即深拷贝收藏 */
export default function CollectDialog({
  kind,
  sourceNodeId,
  onClose,
  onDone,
}: {
  kind: "template" | "card";
  sourceNodeId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [libs, setLibs] = useState<LibraryBrief[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<LibraryBrief[]>("list_libraries", { kind })
      .then(setLibs)
      .catch((e) => window.alert(String(e)))
      .finally(() => setLoaded(true));
  }, [kind]);

  // 按规则分组
  const groups = new Map<string, LibraryBrief[]>();
  for (const lib of libs) {
    const key = lib.ruleName ?? "（全局）";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(lib);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div
        className="flex max-h-[60vh] w-[440px] flex-col rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hairline-soft px-6 py-4">
          <h2 className="text-title-lg text-ink">收藏到库</h2>
          <p className="mt-0.5 text-caption text-muted">
            收藏会复制一份到库中，之后修改/删除原件不影响库里这份。
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {!loaded ? (
            <p className="py-6 text-center text-body-sm text-muted-soft">加载中…</p>
          ) : libs.length === 0 ? (
            <p className="py-6 text-center text-body-sm text-muted">
              还没有{kind === "template" ? "模板库" : "卡片库"}——先在某规则下新建一个。
            </p>
          ) : (
            [...groups.entries()].map(([rule, items]) => (
              <div key={rule} className="mb-4">
                <p className="mb-1 text-caption text-muted-soft">{rule}</p>
                {items.map((lib) => (
                  <button
                    key={lib.nodeId}
                    disabled={busy}
                    className="mb-1.5 h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-left text-body-sm text-ink hover:border-primary hover:text-primary disabled:opacity-50"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await invoke("collect_to_library", { itemNodeId: sourceNodeId, libraryNodeId: lib.nodeId });
                        onDone();
                        onClose();
                      } catch (e) {
                        window.alert(String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {lib.name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end border-t border-hairline-soft px-6 py-3">
          <button
            className="h-10 rounded-md border border-hairline bg-canvas px-4 text-body-sm text-ink hover:bg-surface-soft"
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

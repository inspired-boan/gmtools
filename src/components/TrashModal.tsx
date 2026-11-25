import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTree } from "../store";

interface TrashItem {
  id: string;
  nodeId: string;
  name: string;
  deletedAt: number;
}

export default function TrashModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useTree((s) => s.load);

  const reload = useCallback(async () => {
    const list = await invoke<TrashItem[]>("list_trash");
    setItems(list);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      await load();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[520px] flex-col rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline-soft px-6 py-4">
          <h2 className="text-title-lg text-ink">回收站</h2>
          {items.length > 0 && (
            <button
              disabled={busy}
              className="text-caption text-error hover:underline"
              onClick={() => {
                if (window.confirm("彻底清空回收站？此操作不可恢复。")) {
                  void act(async () => {
                    await invoke("purge_trash", {});
                  });
                }
              }}
            >
              清空
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-6 py-10 text-center text-body-sm text-muted">
              回收站是空的。删除的节点会出现在这里，可随时恢复。
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="flex items-center gap-3 border-b border-hairline-soft px-6 py-3 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-title-sm text-ink">{it.name}</p>
                  <p className="text-caption text-muted-soft">
                    删除于 {new Date(it.deletedAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <button
                  disabled={busy}
                  className="h-8 shrink-0 rounded-md bg-primary px-3 text-caption text-on-primary hover:bg-primary-active disabled:opacity-50"
                  onClick={() =>
                    void act(async () => {
                      await invoke("restore_from_trash", { trashId: it.id });
                    })
                  }
                >
                  恢复
                </button>
                <button
                  disabled={busy}
                  className="h-8 shrink-0 rounded-md border border-hairline px-3 text-caption text-error hover:bg-surface-soft disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`彻底删除「${it.name}」？此操作不可恢复。`)) {
                      void act(async () => {
                        await invoke("purge_trash", { trashId: it.id });
                      });
                    }
                  }}
                >
                  彻底删除
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end border-t border-hairline-soft px-6 py-3">
          <button
            className="h-10 rounded-md bg-primary px-4 text-body-sm text-on-primary hover:bg-primary-active"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

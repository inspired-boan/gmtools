import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTree } from "../store";

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useTree((s) => s.load);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
    } catch (e) {
      setMessage(`出错: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div
        className="w-[480px] rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hairline-soft px-6 py-4">
          <h2 className="text-title-lg text-ink">设置</h2>
        </div>

        <div className="space-y-6 px-6 py-5">
          <section>
            <h3 className="text-title-sm text-ink">数据与备份</h3>
            <p className="mt-1 text-caption text-muted">
              整库导出包含全部节点和图片；节点导出用于分享单个模组。
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                disabled={busy}
                className="h-10 rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink hover:bg-surface-soft disabled:opacity-50"
                onClick={() =>
                  run(async () => {
                    const path = await saveDialog({
                      title: "导出整库备份",
                      defaultPath: "gmtools-backup.gmtools.zip",
                      filters: [{ name: "GM工具备份", extensions: ["zip"] }],
                    });
                    if (!path) return;
                    await invoke("export_full", { path });
                    return "整库导出完成";
                  })
                }
              >
                导出整库
              </button>
              <button
                disabled={busy}
                className="h-10 rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink hover:bg-surface-soft disabled:opacity-50"
                onClick={() =>
                  run(async () => {
                    const path = await openDialog({
                      title: "导入整库备份（将覆盖当前全部数据）",
                      multiple: false,
                      directory: false,
                      filters: [{ name: "GM工具备份", extensions: ["zip"] }],
                    });
                    if (!path) return;
                    await invoke("import_full", { path });
                    await load();
                    return "整库导入完成";
                  })
                }
              >
                导入整库
              </button>
              <button
                disabled={busy}
                className="h-10 rounded-md border border-hairline bg-canvas px-3 text-body-sm text-ink hover:bg-surface-soft disabled:opacity-50"
                onClick={() =>
                  run(async () => {
                    await invoke("open_data_dir");
                  })
                }
              >
                打开数据文件夹
              </button>
            </div>
          </section>

          {message && (
            <div className="rounded-md bg-surface-soft px-3 py-2 text-body-sm text-body">
              {message}
            </div>
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

import Image from "@tiptap/extension-image";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";

/** 存储态 gm-img://id.ext ↔ 展示态（Windows: http://gm-img.localhost/id.ext） */
const GM_IMG_STORED = /gm-img:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g;
const GM_IMG_DISPLAY = /(?:https?:\/\/gm-img\.localhost|gm-img:\/\/localhost)\/([A-Za-z0-9][A-Za-z0-9.-]*)/g;

function storedToDisplay(md: string): string {
  return md.replace(GM_IMG_STORED, (_, p1) => convertFileSrc(p1, "gm-img"));
}

function displayToStored(md: string): string {
  return md.replace(GM_IMG_DISPLAY, "gm-img://$1");
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function uploadImage(file: File): Promise<string> {
  const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
  const ref = await invoke<{ id: string; ext: string }>("save_image", {
    dataBase64: await fileToBase64(file),
    ext,
  });
  return convertFileSrc(`${ref.id}.${ref.ext}`, "gm-img");
}

interface Props {
  nodeId: string;
}

export default function NoteEditor({ nodeId }: Props) {
  const [imgError, setImgError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const pendingContent = useRef<string | null>(null);
  const currentId = useRef(nodeId);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Image,
      Markdown.configure({ html: false, breaks: true, linkify: true }),
    ],
    editorProps: {
      attributes: {
        class: "note-content",
      },
      handlePaste: (view, event) => {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        uploadImage(file)
          .then((src) => {
            const { state, dispatch } = view;
            const node = state.schema.nodes.image.create({ src });
            dispatch(state.tr.replaceSelectionWith(node));
          })
          .catch((e) => setImgError(String(e)));
        return true;
      },
      handleDrop: (view, event) => {
        const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        event.preventDefault();
        uploadImage(file)
          .then((src) => {
            const { state, dispatch } = view;
            const node = state.schema.nodes.image.create({ src });
            dispatch(state.tr.replaceSelectionWith(node));
          })
          .catch((e) => setImgError(String(e)));
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const md = (editor.storage as { markdown?: { getMarkdown?: () => string } }).markdown;
      const stored = displayToStored(md?.getMarkdown?.() ?? "");
      pendingContent.current = stored;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void flushSave();
      }, 800);
    },
  });

  async function flushSave() {
    if (pendingContent.current === null) return;
    const id = currentId.current;
    const content = pendingContent.current;
    pendingContent.current = null;
    await invoke("save_note", { nodeId: id, content }).catch((e) =>
      setImgError(`保存失败: ${e}`),
    );
  }

  // 首次载入笔记内容（组件以 key={nodeId} 渲染，每次切换节点重新挂载）
  useEffect(() => {
    currentId.current = nodeId;
    if (!editor) return;
    void (async () => {
      try {
        const md = await invoke<string>("get_note", { nodeId });
        editor.commands.setContent(storedToDisplay(md));
        pendingContent.current = null;
      } catch (e) {
        setImgError(String(e));
      }
    })();
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, nodeId]);

  // 卸载（切换节点）时冲刷未保存内容
  useEffect(() => {
    return () => {
      void flushSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return <div className="p-6 text-body-sm text-muted">编辑器加载中…</div>;

  const btn = (active: boolean) =>
    `h-8 min-w-8 rounded-sm px-2 text-caption ${
      active ? "bg-surface-cream-strong text-ink" : "text-body hover:bg-surface-soft"
    }`;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-hairline-soft px-2 py-2">
        <button className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button className={btn(editor.isActive("strike"))} onClick={() => editor.chain().focus().toggleStrike().run()}>S̶</button>
        <span className="mx-1 h-4 w-px bg-hairline" />
        <button className={btn(editor.isActive("heading", { level: 1 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
        <button className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button className={btn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
        <span className="mx-1 h-4 w-px bg-hairline" />
        <button className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• 列表</button>
        <button className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. 列表</button>
        <button className={btn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>引用</button>
        <button className={btn(editor.isActive("codeBlock"))} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>代码</button>
        <span className="mx-1 h-4 w-px bg-hairline" />
        <label className={`h-8 cursor-pointer rounded-sm px-2 text-caption leading-8 text-body hover:bg-surface-soft`}>
          图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              uploadImage(f)
                .then((src) => editor.chain().focus().setImage({ src }).run())
                .catch((err) => setImgError(String(err)));
              e.target.value = "";
            }}
          />
        </label>
        <span className="ml-auto text-caption text-muted-soft">自动保存</span>
      </div>

      {imgError && (
        <div className="bg-error/10 px-4 py-2 text-caption text-error">{imgError}</div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

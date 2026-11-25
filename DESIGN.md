# gmtools 设计文档

> 依据 [mpt.md](mpt.md) 的需求拷问确认后整理。MVP（树形目录 / 笔记 / 表格 / 搜索 / 导出）写到实现级；卡片/模板系统（v2）只写概要设计。
> UI 视觉规范见 [DESIGN-claude.md](DESIGN-claude.md)。

## 1. 定位与边界

- **产品**：TRPG 跑团 GM 工具。组织规则、模组、备团/跑团资料，核心载体是树形目录 + 笔记 + 表格。
- **用户**：单机自用。无账号、无云同步、无多人协作。
- **平台**：Tauri 桌面应用，Windows 优先打包；跨平台能力免费保留，不做针对性适配验证。
- **硬性要求**：数据可导出迁移——整库备份恢复 + 节点级 JSON 导出/导入。

### 非目标（第一版明确不做）

- 账号 / 云同步 / 多设备
- 表格公式、排序、筛选、列类型系统
- 卡片单元格、表格卡片视图、模板系统（v2）
- 树结构操作的撤销（以确认弹窗 + 回收站替代）

---

## 2. 技术选型

| 层 | 选择 | 说明 |
|---|---|---|
| 应用框架 | Tauri 2 | 桌面壳，Windows 打包 |
| 前端 | React 18 + TypeScript + Vite | |
| 样式 | Tailwind CSS 3 + 设计 token | token 从 DESIGN-claude.md 映射进 `tailwind.config` |
| 组件 | headless 优先（Radix Primitives）+ 自研 | 视觉完全跟着设计规范走，不引入成品主题库 |
| 状态 | zustand | 树状态、当前选中节点、UI 偏好 |
| 富文本 | TipTap + tiptap-markdown | 所见即所得，序列化存 markdown |
| 数据库 | SQLite（rusqlite，bundled） | Rust 侧持有全部数据逻辑，前端只经 Tauri command 调用 |
| 全文搜索 | SQLite FTS5 | |
| 图片 | 文件系统收纳（数据目录 `/images/`） + 自定义协议访问 | |

### 进程结构

```
┌─ WebView (React) ─────────────────────────┐
│  树导航 / 笔记编辑器 / 表格 / 搜索面板      │
│        │ invoke()                          │
└────────┼───────────────────────────────────┘
         ▼
┌─ Rust 主进程 ─────────────────────────────┐
│  command 层 → 领域服务（树/笔记/表格/搜索） │
│  → rusqlite (gm.db) + images/ 目录        │
└───────────────────────────────────────────┘
```

原则：**数据逻辑全部收口在 Rust**。前端不拼 SQL、不做数据校验，便于后续做导出、迁移、版本迁移。

---

## 3. 数据模型

单库 `gm.db`，SQLite WAL 模式。`node` 是一切的中心表。

```sql
-- 节点：任意嵌套树，规则/模组/备团/跑团都是 label 类型节点
CREATE TABLE node (
  id          TEXT PRIMARY KEY,              -- UUID v4
  parent_id   TEXT REFERENCES node(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- 'label' | 'note' | 'table' | 'card'(v2 预留)
  name        TEXT NOT NULL,
  sort_order  REAL NOT NULL,                 -- 兄弟间排序；插入取 (前+后)/2，避免整段重排
  created_at  INTEGER NOT NULL,              -- unix ms
  updated_at  INTEGER NOT NULL
);

-- 笔记正文（markdown 原文）
CREATE TABLE note (
  node_id  TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  content  TEXT NOT NULL DEFAULT ''
);

-- 表格
CREATE TABLE grid_col (
  id          TEXT PRIMARY KEY,              -- UUID
  node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'markdown'（'card' 为 v2 预留）
  width       INTEGER,
  sort_order  REAL NOT NULL
);

CREATE TABLE grid_row (
  id       TEXT PRIMARY KEY,                 -- UUID
  node_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  sort_order REAL NOT NULL
);

CREATE TABLE grid_cell (
  row_id  TEXT NOT NULL REFERENCES grid_row(id) ON DELETE CASCADE,
  col_id  TEXT NOT NULL REFERENCES grid_col(id) ON DELETE CASCADE,
  value   TEXT,                              -- text 列存纯文本；markdown 列存 markdown 原文
  PRIMARY KEY (row_id, col_id)
);

-- 全文索引（笔记正文 + 表格单元格），Rust 侧在写入时同步维护
CREATE VIRTUAL TABLE fts USING fts5(
  text,
  ref_type UNINDEXED,    -- 'note' | 'cell'
  ref_id   UNINDEXED,    -- note.node_id 或 row_id:col_id
  node_id  UNINDEXED,    -- 归属节点，用于跳转
  tokenize = 'unicode61'
);

-- 回收站：删除 = 子树整体快照入库，随后硬删原数据
CREATE TABLE trash (
  id          TEXT PRIMARY KEY,              -- UUID
  node_id     TEXT NOT NULL,                 -- 原节点 id（恢复时保持不变）
  name        TEXT NOT NULL,
  snapshot    TEXT NOT NULL,                 -- 子树完整 JSON（见 §5.5 导出格式）
  deleted_at  INTEGER NOT NULL
);

-- UI 偏好（窗口尺寸、展开状态、上次选中节点等）
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                        -- JSON
);
```

### 图片

- 图片不进数据库，存 `<数据目录>/images/<uuid>.<ext>`，`images` 表只记元数据（id、ext、created_at）。
- markdown 中引用为 `![alt](gm-img://<id>.<ext>)`；Tauri 注册自定义协议 `gm-img://`，从数据目录读取并带缓存头返回。前端拖拽/粘贴图片 → `save_image` command → 返回 id → 编辑器插入引用。
- 收纳在数据目录内 ⇒ 导出/备份天然包含全部图片。

### 数据目录

- 默认位于系统用户数据目录（`%APPDATA%/gmtools/`），内含 `gm.db` 与 `images/`。
- 设置项：**更改数据目录**（选择新位置，重启生效，Rust 侧完成文件搬迁）与**一键打开数据文件夹**。
- 迁移时用 SQLite backup API 写入新位置后再切换，避免半写状态。

---

## 4. Tauri Command 清单

全部 command 返回 `Result<T, String>`，错误用用户可读中文文案。按领域分模块：

### 树

```ts
get_tree(): TreeSnapshot                       // 全量树（自用规模，一次拉取，增量靠事件推送）
create_node(parentId, type, name): Node
rename_node(id, name)
move_node(id, newParentId, index)              // 拖拽排序，Rust 校验：不得移入自己的子树
copy_node(id, newParentId): Node               // 深拷贝子树，新分配 UUID
delete_node(id)                                // 子树快照入 trash，再硬删，前端弹确认框
```

### 笔记 / 表格

```ts
get_note(nodeId): string
save_note(nodeId, markdown)                    // 写 note + 同步 fts
get_grid(nodeId): Grid                         // 列 + 行 + 稀疏单元格
add_col(nodeId, name, type) / del_col(colId) / rename_col(colId, name) / set_col_width(colId, w)
add_row(nodeId, index?) / del_row(rowId)
set_cell(rowId, colId, value)                  // 写 cell + 同步 fts
```

### 搜索 / 回收站

```ts
search(query): SearchResult[]                  // FTS5 MATCH，返回片段高亮 + 所属节点路径
list_trash(): TrashItem[]
restore_from_trash(trashId)                    // 子树重建；原父节点已不存在则挂到根，名称加 "(已恢复)"
purge_trash(trashId?)                          // 单条 / 清空
```

### 导出 / 导入 / 图片 / 设置

```ts
export_full(path)                              // 打 zip：gm.db（backup API 快照）+ images/
import_full(path)                              // 校验格式 → 替换 → 前端重载
export_node(nodeId, path)                      // 子树 JSON + 内嵌图片（base64）
import_node(path, parentId?)                   // 校验 → 新分配 UUID 写入（避免 id 冲突）
save_image(bytes, ext): ImageRef
get_settings() / set_settings(key, value)
open_data_dir() / change_data_dir(newPath)
```

### 事件

树结构变更、图片变更通过 Tauri event 广播，多窗口/前端各视图保持一致（MVP 单窗口，但接口按事件化设计）。

---

## 5. 功能设计

### 5.1 树形目录

- **布局**：左侧栏固定 280px，树 + 顶部搜索框 + 底部「回收站」「设置」入口；右侧为内容区。
- **节点类型**：`label`（规则/模组/备团/跑团——纯分类）、`note`、`table`（图标区分）。「备团复制成跑团」即 `copy_node`，无特殊逻辑。
- **交互**：
  - 右键菜单：新建子节点（标签/笔记/表格）、复制、重命名、导出、删除。
  - 拖拽移动 + 拖到目标节点间调整排序（`sort_order` 中值插入）。
  - 选中节点持久化到 `settings`，重启恢复现场。
- **删除**：确认弹窗（显示将删除的子树规模「含 N 个子节点」）→ 进回收站。回收站保留条目数不设上限，用户手动清空。

### 5.2 笔记节点

- TipTap 所见即所得，扩展：标题、列表、表格、引用、代码块、粗斜体、删除线、任务列表、图片。
- **存储为 markdown 原文**（tiptap-markdown 双向转换），保证可导出可迁移，FTS 直接索引原文。
- **自动保存**：编辑停顿 800ms 即 `save_note`，标题栏不显示未保存状态（保存是默认行为）；切换节点、关闭窗口前强制 flush。
- **图片**：粘贴/拖入 → `save_image` → 插入 `gm-img://` 引用。
- 编辑器顶部一条工具栏（按设计规范的 button 样式），支持 Ctrl+B/I/Z/Y 等标准快捷键。

### 5.3 表格节点

- 自研轻量网格（MVP 数据量小，不做虚拟滚动）：表头可改名、调宽；行/列右键与「+」按钮增删；文本列单击即编辑，markdown 列双击弹出浮层编辑器（复用 TipTap 配置）。
- 单元格 blur 时 `set_cell` 自动保存。
- 列类型第一版仅 `text` / `markdown`；`grid_col.type='card'` 作为枚举预留，UI 不出现。
- 卡片视图：v2 实装（见 §7）。

### 5.4 全局搜索

- 左栏顶部搜索框，输入即搜（防抖 300ms）。
- 结果列表：节点名 + 命中片段（FTS `snippet()` 高亮），点击 → 树定位并展开 + 内容区打开对应节点；表格命中同时高亮具体单元格。
- 中文分词：`unicode61` 按字处理可满足「子串包含」类检索（查询侧对关键词做前缀 `*` 处理）；若后续体验不足，换 `simple` 分词器扩展，接口不变。

### 5.5 导出与导入

**节点导出**（分享模组）：

```jsonc
{
  "format": "gmtools-node",
  "version": 1,
  "exported_at": "2026-11-24T00:00:00Z",
  "tree": {
    "id": "...", "type": "label", "name": "追书人模组",
    "children": [ /* 递归，含 note.content / grid 全量 */ ]
  },
  "images": { "<imageId>": "data:image/png;base64,..." }
}
```

- 导入时**重新分配所有 UUID**（节点/行/列/图片），图片落库生成新 id；同层级重名不做处理（树允许重名）。

**整库备份**：`export_full` 用 SQLite backup API 生成一致性快照 + images/ 目录打包为 `.gmtools.zip`；导入校验 magic 与版本后替换数据目录并重载。UI 入口在设置页，同时保留「一键打开数据文件夹」手动备份路径。

### 5.6 UI 与设计规范落地

- DESIGN-claude.md 的 YAML token 映射为 Tailwind config 的 `colors / borderRadius / spacing / fontFamily`。
- 字体落地：标题衬线用 `"Cormorant Garamond", "Noto Serif SC", serif`（Copernicus 开源近似替代）；正文用 `Inter, "Noto Sans SC", system-ui`；代码 JetBrains Mono。
- 基调：奶油画布 `#faf9f5` + 珊瑚主色 `#cc785c`（主 CTA、选中态、链接）+ 深色面板 `#181715`（搜索结果浮层、弹窗可考虑深色面板制造节奏）。
- 组件按规范实现：`button-primary`（珊瑚 8px 圆角）、`text-input`（40px 高 + 焦点珊瑚环）、树 hover/选中态用 `surface-card` / `surface-cream-strong` 层级。

---

## 6. 实现顺序（里程碑）

1. **脚手架**：Tauri 2 + React + Vite + Tailwind token 接入，主窗口双栏骨架。
2. **数据层**：schema 建表/迁移框架（`user_version` 递增）、node CRUD + `get_tree`。
3. **树 UI**：树渲染、右键菜单、拖拽、复制、删除→回收站。
4. **笔记**：TipTap 集成、自动保存、图片收纳与 `gm-img://` 协议。
5. **表格**：网格编辑全套 command + UI。
6. **搜索**：FTS5 维护 + 搜索面板 + 跳转。
7. **导出/导入**：节点 JSON、整库 zip、设置页（数据目录管理）。
8. **打磨**：回收站 UI、空态、快捷键、Windows 打包验证。

每个里程碑产出可运行版本；3、4 完成即达到「能备团」的最小可用。

---

## 7. 卡片/模板系统（v2 概要设计）

> 只定边界与接口，不写实现细节。第一版为其预留：`node.type='card'`、`grid_col.type='card'`、图片收纳机制。

### 数据模型（方向）

```
template(id, name, rule_id, components JSON, layout JSON, style JSON, created_at, updated_at)
card(id, node_id, template_id, data JSON)      -- data：组件名 → 填写值
```

- **模板 = 组件列表 + 布局 + 风格**。组件类型：输入框、markdown 输入框、下拉框、分组组件、卡片风格调整组件。
- **卡片节点流程**：新建卡片 → 选模板 → 左填写右实时预览 → 存 `data`。
- **模板界面流程**：定义名称/所属规则 → 添加输入组件 → 调整卡片上组件位置 → 保存。
- **卡片导入/导出**：单卡 JSON（含 template 快照，保证对方没有该模板也能渲染）。

### 与第一版的接口约定

- `grid_col.type='card'`：v2 时单元格存 card id，表格卡片视图按模板渲染——表格视图切换的实现留到 v2，但网格组件的列类型渲染器做成可扩展 map。
- 布局描述采用结构化 JSON（组件坐标/尺寸），不用代码生成，保证模板可导出迁移。

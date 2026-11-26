# gmtools 设计文档

> 依据 [mpt.md](mpt.md) 的需求拷问确认后整理。v1（树形目录 / 笔记 / 表格 / 搜索 / 导出）与 v2（卡片/模板系统）均写到实现级；**两者均已实施完成并经用户验收**（2026-11-26，M1–M11）。v3（模板库/卡片库/跑团面板）设计完成，待实施（M12–M14，见 §8）。
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

## 7. v2 卡片/模板系统

> 经拷问确认的设计（全部决策点已过）。第一版已预留：`node.type='card'`、`grid_col.type='card'`、图片收纳机制。

### 7.0 决策记录

| 决策点 | 结论 |
|---|---|
| 布局模型 | 12 列栅格拖放；组件可跨列设宽（span 1~12），纵向自动排列不重叠 |
| 渲染技术 | 结构化 JSON + React 渲染器，不用 HTML/CSS 字符串模板 |
| 风格 | 5 套预设主题 + 单组件覆盖颜色/字号 |
| 模板归属 | 挂规则节点下（`rule_id`），规则内共享；跨规则复制模板节点 |
| 组件集 | 7 种：text / markdown / number / dropdown（静态选项）/ image / group（一层嵌套）/ style（风格调整） |
| 组件属性 | 标签、占位提示、默认值、必填、跨列宽度 |
| 模板修改 | 实时生效；被删组件的卡片数据保留但不渲染；保存时提示"应用于 N 张卡片" |
| 模板存放 | 树节点类型 `template`，点开即编辑器 |
| 表格卡片视图 | 表格可选模板 + 列→组件映射；配置存 settings（键控节点 id），快照随行 |
| 卡片空态 | 引导态：列出可用模板；无模板提示先创建 |
| 下拉选项 | 静态定义；动态引用（表格列取值）留 v3 接口 |
| 卡片尺寸 | 预设：npc 竖卡 420×595 / item 横卡 595×420 / art 全宽立绘 760×570（px，可缩放渲染） |
| 交付顺序 | 模板编辑器 → 卡片节点 → 表格卡片视图，三步各自可运行 |

### 7.1 数据模型（迁移 v4）

```sql
CREATE TABLE template (
  node_id     TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  rule_id     TEXT,                           -- 最近的 label 祖先；根级模板为 NULL（全局可用）
  size        TEXT NOT NULL DEFAULT 'npc',    -- 'npc' | 'item' | 'art'
  theme       TEXT NOT NULL DEFAULT 'cream',
  components  TEXT NOT NULL DEFAULT '[]',     -- 组件定义 JSON（见 7.2）
  updated_at  INTEGER NOT NULL
);

CREATE TABLE card (
  node_id     TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,                  -- 模板节点 id
  data        TEXT NOT NULL DEFAULT '{}',     -- 组件id → 填写值（JSON）
  updated_at  INTEGER NOT NULL
);
```

- 表格卡片视图配置：`settings` 表，键 `cardview:<表格节点id>`，值 `{ templateId, mapping }` JSON；节点快照导出时随行（NodeSnapshot 增加 `cardView` 字段）。
- `node.type` 枚举扩展为 `label | note | table | template | card`。

### 7.2 组件定义 JSON

```jsonc
// template.components 数组元素；分组组件含一层 children
{
  "id": "c_ab12",                // 组件 id，卡片 data 的 key；nanoid 短 id
  "type": "text",                // text | markdown | number | dropdown | image | group | style
  "label": "姓名",
  "placeholder": "",
  "default": "",
  "required": false,
  "span": 6,                     // 跨列数 1~12，默认 6
  "options": ["存活", "死亡"],    // 仅 dropdown
  "children": [ /* 仅 group，一层 */ ],
  "style": { "color": "", "fontSize": "" }  // 覆盖项，空串表示跟随主题
}
```

- 布局 = **数组顺序**（画布上拖拽排序即改数组）+ 每个组件的 `span`；group 的 `children` 内部同样适用。
- 卡片 `data` 以组件 `id` 为 key：`{ "c_ab12": "艾琳", "c_cd34": 17 }`。组件被删后对应 data 项保留（不渲染），模板恢复后自动回显。

### 7.3 主题预设

| key | 名 | 基调（取自 DESIGN-claude.md 色板） |
|---|---|---|
| `cream` | 素雅 | 画布 #faf9f5 + 墨字 + hairline 边框（默认） |
| `dark` | 暗夜 | #181715 底 + on-dark 字 + 深色高亮 |
| `coral` | 珊瑚 | 奶油底 + 珊瑚色标题/边框强调 |
| `forest` | 墨林 | #1f2a24 底 + 青绿强调（accent-teal） |
| `parchment` | 羊皮纸 | #e8e0d2 底 + 棕墨字 + 双线边框 |

主题实现：渲染器读 CSS 变量组（每主题一组 `--card-bg/--card-ink/--card-accent/--card-border`），组件级 `style` 覆盖以 inline style 优先。

### 7.4 Tauri Command

```ts
// 模板
get_template(nodeId): TemplateDto                // { nodeId, ruleId, size, theme, components }
save_template(nodeId, size, theme, components)   // 编辑器整体保存；返回受影响卡片数（前端提示用）
count_cards_using(templateNodeId): number
list_templates_for(nodeId): TemplateBrief[]      // 卡片可用模板：rule_id 匹配卡片最近的 label 祖先 或 NULL

// 卡片
get_card(nodeId): { templateId, data } | null
save_card(nodeId, templateId, data)              // 选模板（或换模板）+ 填写均走此命令
list_cards_using(templateNodeId): NodeBrief[]    // "应用于 N 张卡片"提示 + 模板节点页显示引用列表

// 表格卡片视图
get_card_view(nodeId): { templateId, mapping } | null   // mapping: colId → componentId
set_card_view(nodeId, config | null)
```

### 7.5 功能设计

**模板编辑器**（模板节点的内容区）
- 三段布局：左侧组件库（7 种，点击/拖入画布）· 中间 12 列栅格画布（按选定尺寸渲染底板，拖拽排序、点选编辑）· 右侧属性面板（选中组件的属性 + 主题/尺寸选择器）。
- 画布组件呈"骨架态"：显示标签、占位示意，不渲染真实数据；拖拽用 HTML5 DnD（与树拖拽同一套手感）。
- group 组件拖入后成为容器，子组件可拖入其内部栅格；一层嵌套上限在拖拽层校验。
- 保存策略：编辑停顿 800ms 自动 `save_template` + 手动保存按钮；保存时若 `count_cards_using > 0` 顶部提示"此模板已被 N 张卡片使用"。

**卡片节点**
- 新建卡片节点 → 引导态：列出可用模板（rule 匹配 + 全局），点击选定并进入填写态；规则下无模板时提示"先在某规则下新建模板节点"。
- 填写态：左侧按组件类型渲染输入控件（必填项标红星，未填完不影响保存），右侧实时预览（CardRenderer view 模式，按模板主题渲染）。
- 图片组件：点击/拖拽上传 → 复用 `save_image` + `gm-img://` 引用。
- 导入/导出：复用节点导出管线——`NodeSnapshot` 增加 `template` / `card` / `cardView` 三个可选字段；导出单张卡时自动内嵌其模板定义，对方导入即得完整可渲染卡片。

**表格卡片视图**
- 表格节点内容区顶部加"表格 / 卡片"切换；首次切卡片时引导选择模板 + 列映射（下拉选列 → 组件）。
- 卡片墙：按 `sort_order` 排列的模板卡（复用 CardRenderer），单元格值为空时组件显示占位。
- 映射配置存 `settings`；快照/导出表格节点时一并带走。

**渲染器（CardRenderer）**
- 单一 React 组件三模式：`edit`（模板编辑器骨架）/ `fill`（卡片填写）/ `view`（预览与卡片墙）。
- 组件渲染器做成 map（`text → <input>`、`markdown → 只读 md 渲染`、`image → <img>`…），`grid_col.type='card'` 的 v3 扩展点也落在这张 map 上。

### 7.6 v2 里程碑（✅ 全部完成，2026-11-26）

1. **M9 模板编辑器**：迁移 v4/v5 + template commands + 编辑器 UI（组件库/栅格画布/属性面板/主题尺寸/自动高度）。
2. **M10 卡片节点**：card commands + 引导态 + 填写/预览 + 快照扩展（单卡导出内嵌模板，导入自动重建）。
3. **M11 表格卡片视图**：视图配置 + 列映射 + 卡片墙 + 随时重新配置（预填当前配置）。

### 7.7 与第一版的接口约定（继承）

- `grid_col.type='card'`（单元格直接存卡片引用）留 v3；本轮表格卡片视图走"列映射"方案，不动 grid_cell 结构。
- 下拉框动态数据源留 v3：`options` 字段允许后续扩展为 `{ source: "table", colId }` 对象形式，静态数组保持兼容。

---

## 8. v3 模板库 / 卡片库 / 跑团面板

> 经拷问确认的设计（两轮 17 决策）。复用 v1 任意嵌套树、快照/导出管线、v2 卡片渲染器。

### 8.0 决策记录

| 决策点 | 结论 |
|---|---|
| 库的形态 | 树节点：`node.type` 扩展 `tplLib` / `cardLib`，任意规则下可建任意多个，点开为库管理界面 |
| 收藏语义 | 复制快照 + 可选"同步自来源"（`library_meta` 记来源 id，来源已删则置灰） |
| 库项能力 | 完全可编辑（模板可进编辑器、卡片可填写），只是住在库里 |
| 卡片库收藏 | 卡片数据 + 模板定义完整带走；从库创建 = 复制整张含数据的卡 |
| 白板卡片来源 | 引用树上卡片节点（数据单份），双击白板卡片定位原节点 |
| 数据交换 | **面板级共享变量表**：卡片字段绑定变量，改一处全联动（"中台"）；字段值存 `@变量名` 标记 |
| +1/-1 | 白板上所有数字字段悬停显示；绑变量的改变量，未绑定的改卡片数据；树里卡片填写视图同款（仅普通数字） |
| 白板 MVP | 自由拖拽摆位 + 记住位置、Ctrl+滚轮缩放（0.5~1.5）、快捷 +1/-1、变量表、面板级导出；连线/框选/吸附留 v4 |
| 收藏入口 | 右键菜单"收藏到库…" + 模板编辑器顶部 + 卡片填写面板头部 |
| 添加卡片 | 树拖入白板 + 白板「+」列表双通道 |
| 面板导出 | 面板摆位 + 变量表 + 引用的所有卡片子树（含模板）打包，导入 id 全重映射 |
| 交付顺序 | M12 库 → M13 白板基础 → M14 变量中台 |

### 8.1 数据模型（迁移 v6）

```sql
-- 库项来源（同步按钮用）
CREATE TABLE library_meta (
  node_id        TEXT PRIMARY KEY,          -- 库项（库节点的子节点）
  source_node_id TEXT NOT NULL,             -- 收藏时的原节点
  kind           TEXT NOT NULL,             -- 'template' | 'card'
  collected_at   INTEGER NOT NULL
);

-- 白板摆位
CREATE TABLE panel_items (
  node_id      TEXT NOT NULL,               -- 面板节点 id
  card_node_id TEXT NOT NULL,               -- 被引用的卡片节点 id
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  PRIMARY KEY (node_id, card_node_id)
);

-- 面板共享变量
CREATE TABLE panel_vars (
  node_id    TEXT NOT NULL,                 -- 面板节点 id
  name       TEXT NOT NULL,                 -- 变量名（面板内唯一）
  value      TEXT NOT NULL DEFAULT '0',     -- 数字或文本
  sort_order REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, name)
);
```

- `node.type` 枚举扩展为 `label | note | table | template | card | tplLib | cardLib | panel`。
- **变量绑定标记**：卡片 data 中字段值为 `"@变量名"` 时表示绑定面板变量；渲染时面板负责解析为当前变量值（树里无面板上下文，显示标记原文）；+1/-1 对绑定字段改写 `panel_vars`，对普通数字改写 data。
- 面板快照（NodeSnapshot 扩展 `panel` 字段）：`{ items: [{cardNodeId,x,y}], vars: [{name,value}], refs: [卡片子树快照...] }`——导出时 refs 收录全部被引用卡片，导入重建并重映射（卡片新 id 回填 items）。

### 8.2 Tauri Command

```ts
// 库
collect_to_library(itemNodeId, libraryNodeId)   // 深拷贝进库 + 记 library_meta
list_library_meta(itemNodeId): { sourceNodeId } | null
sync_from_source(itemNodeId)                    // 用来源节点当前内容覆盖库项

// 面板
get_panel(nodeId): { items, vars }              // 摆位 + 变量（卡片内容走现有树/卡片 command）
set_panel_item(nodeId, cardNodeId, x, y)        // 拖拽落点，upsert
remove_panel_item(nodeId, cardNodeId)
add_panel_var(nodeId, name, value) / del_panel_var / rename_panel_var / set_panel_var_value
get_card_value_at(cardNodeId, compId): string   // 面板渲染：解析 @标记 / 原始值
bump_card_value(cardNodeId, compId, delta)      // +1/-1：绑变量则改 panel_vars（跨卡片联动），否则改 data
```

### 8.3 功能设计

**库管理界面**（点开 tplLib / cardLib 节点）
- 网格列出子节点（模板项显示主题缩略示意，卡片项显示渲染卡面）；顶部"从规则中收藏"引导（空态时）
- 项操作：打开（进编辑器/填写）、重命名、同步自来源（来源存在时）、取出到…（复制到指定节点下）、删除
- 树上库节点可直接展开看到子项（不隐藏），右键菜单同库界面操作

**收藏流程**
- 右键"收藏到库…"→ 弹窗列出全部库节点（按规则分组）→ 选定即深拷贝
- 模板编辑器头部 / 卡片填写面板头部：同款按钮，免去回到树上右键

**跑团面板白板**
- 画布：无限大的定位区（viewport 平移 + Ctrl+滚轮缩放 0.5~1.5），卡片按 panel_items 坐标绝对定位，渲染复用 CardRenderer（view 模式）
- 添加：树中拖卡片节点入白板（drop 落点即坐标）；白板「+」→ 列出全部卡片节点（按规则分组）点选
- 拖动卡片：mousedown 拖动 + 松手 set_panel_item；拖动中本地即时位移
- 失效引用：引用的卡片节点被删 → 白板灰显占位卡"已失效"，点击可移除 panel_items
- 双击白板卡片 → 树定位并打开该卡片节点

**变量中台**
- 变量表 UI：白板右侧可收起抽屉——列表（名称/值/±按钮）、新建、改名、删除
- 绑定：白板卡片字段悬停出现 ⛓ 图标 → 弹出变量列表（可现场新建）→ 选定即把该字段 data 值改写为 `@变量名`
- 联动：任一处（变量表直接改值、白板 +1/-1、绑定字段修改）→ 变量更新 → 事件广播 → 所有绑定该变量的白板卡片即时重渲染
- +1/-1：白板数字字段悬停右上角浮出 [+][-]；按住 Shift 为 ±5

**面板导出/导入**
- 导出面板节点 = NodeSnapshot.panel（items + vars + refs 卡片子树）——refs 由后端按 panel_items 自动收集
- 导入：refs 子树重建（id 重映射）→ items 的 cardNodeId 回填新 id → vars 原样恢复 → 摆位不变

### 8.4 v3 里程碑

1. **M12 模板库 + 卡片库**：节点类型 + 收藏/同步/取出 + 库管理界面 + 创建卡片模板列表扩展。
2. **M13 面板白板基础**：panel 节点 + panel_items + 白板渲染/拖拽/缩放 + 树拖入/列表添加 + 失效占位。
3. **M14 变量中台**：panel_vars + 变量抽屉 + 字段绑定 + 实时联动 + +1/-1 + 面板导出/导入。

M12 纯复用现有管线；M13 完成即"能把 PC/据点卡摆上白板"；M14 完成即完整数据中台闭环。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

pub struct Db(pub Mutex<Connection>);

pub const NODE_TYPES: [&str; 8] = [
    "label", "note", "table", "template", "card", "tplLib", "cardLib", "panel",
];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ---------- DTO ----------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub name: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl<'a> From<&'a Row<'a>> for NodeDto {
    fn from(r: &'a Row<'a>) -> Self {
        NodeDto {
            id: r.get(0).unwrap(),
            parent_id: r.get(1).unwrap(),
            node_type: r.get(2).unwrap(),
            name: r.get(3).unwrap(),
            sort_order: r.get(4).unwrap(),
            created_at: r.get(5).unwrap(),
            updated_at: r.get(6).unwrap(),
        }
    }
}

const NODE_COLS: &str = "id, parent_id, type, name, sort_order, created_at, updated_at";

// ---------- 快照（回收站 / 导出共用） ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub name: String,
    pub sort_order: f64,
    pub note: Option<String>,
    pub cols: Vec<ColSnapshot>,
    pub rows: Vec<RowSnapshot>,
    pub cells: Vec<CellSnapshot>,
    pub children: Vec<NodeSnapshot>,
    #[serde(default)]
    pub template: Option<TemplateSnapshot>,
    #[serde(default)]
    pub card: Option<CardSnapshot>,
    #[serde(default)]
    pub card_view: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSnapshot {
    pub rule_id: Option<String>,
    pub size: String,
    pub theme: String,
    pub components: serde_json::Value,
    #[serde(default)]
    pub auto_height: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSnapshot {
    pub template_id: String,
    pub data: serde_json::Value,
    /// 单卡导出时内嵌的模板定义；导入时若目标库没有该模板则自动重建
    #[serde(default)]
    pub template: Option<TemplateSnapshot>,
    #[serde(default)]
    pub template_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColSnapshot {
    pub id: String,
    pub name: String,
    pub col_type: String,
    pub width: Option<i64>,
    pub sort_order: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSnapshot {
    pub id: String,
    pub sort_order: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSnapshot {
    pub row_id: String,
    pub col_id: String,
    pub value: Option<String>,
}

pub fn snapshot_node(conn: &Connection, id: &str) -> Result<NodeSnapshot, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM node WHERE id = ?1", NODE_COLS))
        .map_err(|e| e.to_string())?;
    let (base_id, parent_id, node_type, name, sort_order) = stmt
        .query_row(params![id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, f64>(4)?,
            ))
        })
        .map_err(|_| format!("节点 {} 不存在", id))?;

    let note: Option<String> = conn
        .query_row("SELECT content FROM note WHERE node_id = ?1", params![id], |r| r.get(0))
        .ok();

    let mut cols = Vec::new();
    if node_type == "table" {
        let mut stmt = conn
            .prepare("SELECT id, name, type, width, sort_order FROM grid_col WHERE node_id = ?1 ORDER BY sort_order")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok(ColSnapshot {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    col_type: r.get(2)?,
                    width: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for c in rows {
            cols.push(c.map_err(|e| e.to_string())?);
        }
    }

    let mut rows = Vec::new();
    let mut cells = Vec::new();
    if node_type == "table" {
        let mut stmt = conn
            .prepare("SELECT id, sort_order FROM grid_row WHERE node_id = ?1 ORDER BY sort_order")
            .map_err(|e| e.to_string())?;
        let rrows = stmt
            .query_map(params![id], |r| {
                Ok(RowSnapshot { id: r.get(0)?, sort_order: r.get(1)? })
            })
            .map_err(|e| e.to_string())?;
        for r in rrows {
            rows.push(r.map_err(|e| e.to_string())?);
        }
        let mut stmt = conn
            .prepare(
                "SELECT c.row_id, c.col_id, c.value FROM grid_cell c
                 JOIN grid_row r ON r.id = c.row_id WHERE r.node_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let crows = stmt
            .query_map(params![id], |r| {
                Ok(CellSnapshot {
                    row_id: r.get(0)?,
                    col_id: r.get(1)?,
                    value: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for c in crows {
            cells.push(c.map_err(|e| e.to_string())?);
        }
    }

    let mut children = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id FROM node WHERE parent_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let child_ids = stmt
        .query_map(params![id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for cid in child_ids {
        children.push(snapshot_node(conn, &cid)?);
    }

    // v2：模板 / 卡片 / 表格卡片视图配置
    let template = if node_type == "template" {
        conn.query_row(
            "SELECT rule_id, size, theme, components, auto_height FROM template WHERE node_id = ?1",
            params![id],
            |r| {
                Ok(TemplateSnapshot {
                    rule_id: r.get(0)?,
                    size: r.get(1)?,
                    theme: r.get(2)?,
                    components: serde_json::from_str(&r.get::<_, String>(3)?)
                        .unwrap_or(serde_json::Value::Array(vec![])),
                    auto_height: r.get::<_, i64>(4)? != 0,
                })
            },
        )
        .ok()
    } else {
        None
    };

    let card_view = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![format!("cardview:{}", id)],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let card = if node_type == "card" {
        let (template_id, data): (String, String) = match conn.query_row(
            "SELECT template_id, data FROM card WHERE node_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ) {
            Ok(v) => v,
            Err(_) => return Ok(NodeSnapshot {
                id: base_id,
                parent_id,
                node_type,
                name,
                sort_order,
                note,
                cols,
                rows,
                cells,
                children,
                template: None,
                card: None,
                card_view,
            }),
        };
        // 内嵌模板定义：导出单卡时对方没有模板也能渲染
        let template = conn
            .query_row(
                "SELECT rule_id, size, theme, components, auto_height FROM template WHERE node_id = ?1",
                params![template_id],
                |r| {
                    Ok(TemplateSnapshot {
                        rule_id: r.get(0)?,
                        size: r.get(1)?,
                        theme: r.get(2)?,
                        components: serde_json::from_str(&r.get::<_, String>(3)?)
                            .unwrap_or(serde_json::Value::Array(vec![])),
                        auto_height: r.get::<_, i64>(4)? != 0,
                    })
                },
            )
            .ok();
        let template_name: Option<String> = conn
            .query_row("SELECT name FROM node WHERE id = ?1", params![template_id], |r| r.get(0))
            .ok();
        Some(CardSnapshot {
            template_id,
            data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Object(Default::default())),
            template,
            template_name,
        })
    } else {
        None
    };

    Ok(NodeSnapshot {
        id: base_id,
        parent_id,
        node_type,
        name,
        sort_order,
        note,
        cols,
        rows,
        cells,
        children,
        template,
        card,
        card_view,
    })
}

pub fn insert_snapshot(
    conn: &Connection,
    snap: &NodeSnapshot,
    new_parent: Option<&str>,
    name_override: Option<&str>,
    regenerate_ids: bool,
) -> Result<String, String> {
    let id = if regenerate_ids { new_id() } else { snap.id.clone() };
    let name = name_override.unwrap_or(&snap.name).to_string();
    let ts = now_ms();
    conn.execute(
        &format!(
            "INSERT INTO node ({}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            NODE_COLS
        ),
        params![id, new_parent, snap.node_type, name, snap.sort_order, ts, ts],
    )
    .map_err(|e| e.to_string())?;

    if let Some(content) = &snap.note {
        conn.execute(
            "INSERT INTO note (node_id, content) VALUES (?1, ?2)",
            params![id, content],
        )
        .map_err(|e| e.to_string())?;
    }

    if snap.node_type == "table" {
        for c in &snap.cols {
            let col_id = if regenerate_ids { new_id() } else { c.id.clone() };
            conn.execute(
                "INSERT INTO grid_col (id, node_id, name, type, width, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![col_id, id, c.name, c.col_type, c.width, c.sort_order],
            )
            .map_err(|e| e.to_string())?;
        }
        for r in &snap.rows {
            let row_id = if regenerate_ids { new_id() } else { r.id.clone() };
            conn.execute(
                "INSERT INTO grid_row (id, node_id, sort_order) VALUES (?1, ?2, ?3)",
                params![row_id, id, r.sort_order],
            )
            .map_err(|e| e.to_string())?;
        }
        for cell in &snap.cells {
            // 重新生成 id 时行列 id 已变化，需按快照内顺序映射；MVP 快照顺序即列/行顺序
            let row_id = if regenerate_ids {
                let idx = snap.rows.iter().position(|r| r.id == cell.row_id).ok_or("快照数据损坏：行不匹配")?;
                let _ = idx; // row_id 由插入顺序生成，这里直接查回
                conn.query_row(
                    "SELECT id FROM grid_row WHERE node_id = ?1 ORDER BY sort_order LIMIT 1 OFFSET ?2",
                    params![id, idx],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| e.to_string())?
            } else {
                cell.row_id.clone()
            };
            let col_id = if regenerate_ids {
                let idx = snap.cols.iter().position(|c| c.id == cell.col_id).ok_or("快照数据损坏：列不匹配")?;
                conn.query_row(
                    "SELECT id FROM grid_col WHERE node_id = ?1 ORDER BY sort_order LIMIT 1 OFFSET ?2",
                    params![id, idx],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| e.to_string())?
            } else {
                cell.col_id.clone()
            };
            conn.execute(
                "INSERT OR IGNORE INTO grid_cell (row_id, col_id, value) VALUES (?1, ?2, ?3)",
                params![row_id, col_id, cell.value],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // v2：模板 / 卡片 / 卡片视图配置
    if let Some(t) = &snap.template {
        conn.execute(
            "INSERT OR REPLACE INTO template (node_id, rule_id, size, theme, components, auto_height, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                t.rule_id,
                t.size,
                t.theme,
                serde_json::to_string(&t.components).unwrap_or_else(|_| "[]".to_string()),
                t.auto_height as i64,
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(c) = &snap.card {
        // 模板在目标库缺失时用内嵌定义重建（挂根，全局可用），并重映射 template_id
        let mut template_id = c.template_id.clone();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM template WHERE node_id = ?1",
                params![template_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            if let Some(t) = &c.template {
                let new_tid = new_id();
                let name = format!(
                    "{}（导入）",
                    c.template_name.clone().unwrap_or_else(|| "模板".to_string())
                );
                let ts = now_ms();
                conn.execute(
                    &format!("INSERT INTO node ({}) VALUES (?1, NULL, 'template', ?2, 0, ?3, ?4)", NODE_COLS),
                    params![new_tid, name, ts, ts],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO template (node_id, rule_id, size, theme, components, auto_height, updated_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        new_tid,
                        t.size,
                        t.theme,
                        serde_json::to_string(&t.components).unwrap_or_else(|_| "[]".to_string()),
                        t.auto_height as i64,
                        ts
                    ],
                )
                .map_err(|e| e.to_string())?;
                template_id = new_tid;
            }
        }
        conn.execute(
            "INSERT OR REPLACE INTO card (node_id, template_id, data, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                id,
                template_id,
                serde_json::to_string(&c.data).unwrap_or_else(|_| "{}".to_string()),
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(cv) = &snap.card_view {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![
                format!("cardview:{}", id),
                serde_json::to_string(cv).unwrap_or_default()
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for child in &snap.children {
        insert_snapshot(conn, child, Some(&id), None, regenerate_ids)?;
    }
    Ok(id)
}

// ---------- 排序辅助 ----------

fn sibling_orders(conn: &Connection, parent: Option<&str>) -> Result<Vec<f64>, String> {
    let mut stmt = conn
        .prepare("SELECT sort_order FROM node WHERE parent_id IS ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let v = stmt
        .query_map(params![parent], |r| r.get::<_, f64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

fn sort_order_at(orders: &[f64], index: usize) -> f64 {
    if orders.is_empty() {
        return 1000.0;
    }
    if index == 0 {
        return orders[0] - 1000.0;
    }
    if index >= orders.len() {
        return orders[orders.len() - 1] + 1000.0;
    }
    (orders[index - 1] + orders[index]) / 2.0
}

fn is_descendant(conn: &Connection, ancestor: &str, maybe_child: &str) -> Result<bool, String> {
    let mut current = maybe_child.to_string();
    loop {
        let row = conn.query_row(
            "SELECT parent_id FROM node WHERE id = ?1",
            params![current],
            |r| r.get::<_, Option<String>>(0),
        );
        match row {
            Err(_) => return Err("节点不存在".to_string()),
            Ok(None) => return Ok(false),
            Ok(Some(p)) if p == ancestor => return Ok(true),
            Ok(Some(p)) => current = p,
        }
    }
}

// ---------- Commands ----------

#[tauri::command]
pub fn get_tree(state: State<Db>) -> Result<Vec<NodeDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM node ORDER BY parent_id, sort_order",
            NODE_COLS
        ))
        .map_err(|e| e.to_string())?;
    let nodes = stmt
        .query_map([], |r| Ok(NodeDto::from(r)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(nodes)
}

#[tauri::command]
pub fn create_node(
    state: State<Db>,
    parent_id: Option<String>,
    node_type: String,
    name: String,
) -> Result<NodeDto, String> {
    if !NODE_TYPES.contains(&node_type.as_str()) {
        return Err(format!("未知节点类型: {}", node_type));
    }
    if name.trim().is_empty() {
        return Err("名称不能为空".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = &parent_id {
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM node WHERE id = ?1", params![pid], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("父节点不存在".to_string());
        }
    }
    let id = new_id();
    let ts = now_ms();
    let orders = sibling_orders(&conn, parent_id.as_deref())?;
    let order = orders.last().map(|m| m + 1000.0).unwrap_or(1000.0);
    conn.execute(
        &format!("INSERT INTO node ({}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", NODE_COLS),
        params![id, parent_id, node_type, name.trim(), order, ts, ts],
    )
    .map_err(|e| e.to_string())?;
    if node_type == "note" {
        conn.execute("INSERT INTO note (node_id, content) VALUES (?1, '')", params![id])
            .map_err(|e| e.to_string())?;
    }
    if node_type == "template" {
        // 归属：父链上最近的 label 祖先（规则）；根级模板 rule_id 为 NULL（全局可用）
        let rule_id = nearest_label_ancestor(&conn, parent_id.as_deref())?;
        conn.execute(
            "INSERT INTO template (node_id, rule_id, size, theme, components, auto_height, updated_at) VALUES (?1, ?2, 'npc', 'cream', '[]', 0, ?3)",
            params![id, rule_id, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(NodeDto {
        id,
        parent_id,
        node_type,
        name: name.trim().to_string(),
        sort_order: order,
        created_at: ts,
        updated_at: ts,
    })
}

#[tauri::command]
pub fn rename_node(state: State<Db>, id: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名称不能为空".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE node SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name.trim(), now_ms()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("节点不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn move_node(
    state: State<Db>,
    id: String,
    new_parent_id: Option<String>,
    index: usize,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = &new_parent_id {
        if pid == &id {
            return Err("不能把节点移到自己下面".to_string());
        }
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM node WHERE id = ?1", params![pid], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("目标父节点不存在".to_string());
        }
        if is_descendant(&conn, &id, pid)? {
            return Err("不能把节点移到自己的子节点下".to_string());
        }
    }
    let mut orders = sibling_orders(&conn, new_parent_id.as_deref())?;
    // 排除自身（同层移动时 index 语义按"移除自己后的位置"）
    let old_parent: Option<String> = conn
        .query_row("SELECT parent_id FROM node WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|_| "节点不存在".to_string())?;
    if old_parent == new_parent_id {
        if let Ok(pos) = orders.binary_search_by(|o| o.total_cmp(&{
            conn.query_row("SELECT sort_order FROM node WHERE id = ?1", params![id], |r| r.get::<_, f64>(0))
                .unwrap()
        })) {
            orders.remove(pos);
        }
    }
    let order = sort_order_at(&orders, index);
    conn.execute(
        "UPDATE node SET parent_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, new_parent_id, order, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn copy_node(
    state: State<Db>,
    id: String,
    new_parent_id: Option<String>,
    new_name: Option<String>,
) -> Result<NodeDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = &new_parent_id {
        if pid == &id || is_descendant(&conn, &id, pid)? {
            return Err("不能把节点复制到自己的子节点下".to_string());
        }
    }
    let snap = snapshot_node(&conn, &id)?;
    let orders = sibling_orders(&conn, new_parent_id.as_deref())?;
    let order = orders.last().map(|m| m + 1000.0).unwrap_or(1000.0);
    let mut snap = snap;
    snap.sort_order = order;
    let ts = now_ms();
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let result = insert_snapshot(&conn, &snap, new_parent_id.as_deref(), new_name.as_deref(), true);
    if let Err(e) = result {
        let _ = conn.execute("ROLLBACK", []);
        return Err(e);
    }
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    let new_id = result?;
    let dto = conn
        .query_row(
            &format!("SELECT {} FROM node WHERE id = ?1", NODE_COLS),
            params![new_id],
            |r| Ok(NodeDto::from(r)),
        )
        .map_err(|e| e.to_string())?;
    let _ = ts;
    Ok(dto)
}

#[tauri::command]
pub fn delete_node(state: State<Db>, id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let snap = snapshot_node(&conn, &id)?;
    let deleted_at = now_ms();
    let trash_id = new_id();
    let snapshot_json = serde_json::to_string(&snap).map_err(|e| e.to_string())?;

    // 统计子树规模供前端确认展示
    let count = count_subtree(&conn, &id)?;

    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO trash (id, node_id, name, snapshot, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![trash_id, id, snap.name, snapshot_json, deleted_at],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM node WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?; // 级联删除子树与 note/grid
        Ok(())
    })();
    if let Err(e) = r {
        let _ = conn.execute("ROLLBACK", []);
        return Err(e);
    }
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(count)
}

/// 从给定节点向上找最近的 label（规则）祖先；到达根返回 None
pub fn nearest_label_ancestor(conn: &Connection, start: Option<&str>) -> Result<Option<String>, String> {
    let mut current = match start {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };
    loop {
        let row = conn.query_row(
            "SELECT parent_id, type FROM node WHERE id = ?1",
            params![current],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
        );
        match row {
            Err(_) => return Ok(None),
            Ok((_, t)) if t == "label" => return Ok(Some(current)),
            Ok((None, _)) => return Ok(None),
            Ok((Some(p), _)) => current = p,
        }
    }
}

fn count_subtree(conn: &Connection, id: &str) -> Result<usize, String> {    let mut stmt = conn
        .prepare("SELECT id FROM node WHERE parent_id = ?1")
        .map_err(|e| e.to_string())?;
    let children = stmt
        .query_map(params![id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(1 + children
        .iter()
        .map(|c| count_subtree(conn, c).unwrap_or(0))
        .sum::<usize>())
}

// ---------- 设置 ----------

#[tauri::command]
pub fn get_setting(state: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let v = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .ok();
    Ok(v)
}

#[tauri::command]
pub fn set_setting(state: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 回收站 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemDto {
    pub id: String,
    pub node_id: String,
    pub name: String,
    pub deleted_at: i64,
}

#[tauri::command]
pub fn list_trash(state: State<Db>) -> Result<Vec<TrashItemDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, node_id, name, deleted_at FROM trash ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([], |r| {
            Ok(TrashItemDto {
                id: r.get(0)?,
                node_id: r.get(1)?,
                name: r.get(2)?,
                deleted_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(items)
}

/// 恢复：重新分配 UUID（避免与现存节点冲突），原父节点已不存在则挂到根。
/// 图片文件不随快照走（引用 id 不变），恢复后引用依然有效。
#[tauri::command]
pub fn restore_from_trash(state: State<Db>, trash_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let snapshot: String = conn
        .query_row("SELECT snapshot FROM trash WHERE id = ?1", params![trash_id], |r| r.get(0))
        .map_err(|_| "回收站条目不存在".to_string())?;
    let snap: NodeSnapshot =
        serde_json::from_str(&snapshot).map_err(|_| "快照数据损坏".to_string())?;

    // 原父节点仍在则挂回原位，否则挂到根
    let parent_target: Option<String> = match &snap.parent_id {
        Some(pid) => {
            let exists: i64 = conn
                .query_row("SELECT COUNT(*) FROM node WHERE id = ?1", params![pid], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if exists > 0 {
                Some(pid.clone())
            } else {
                None
            }
        }
        None => None,
    };

    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        insert_snapshot(&conn, &snap, parent_target.as_deref(), None, true)?;
        conn.execute("DELETE FROM trash WHERE id = ?1", params![trash_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = r {
        let _ = conn.execute("ROLLBACK", []);
        return Err(e);
    }
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(())
}

/// 彻底删除：传 id 删单条，None 清空全部
#[tauri::command]
pub fn purge_trash(state: State<Db>, trash_id: Option<String>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    match trash_id {
        Some(id) => {
            conn.execute("DELETE FROM trash WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM trash", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

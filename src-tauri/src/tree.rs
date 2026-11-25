use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

pub struct Db(pub Mutex<Connection>);

pub const NODE_TYPES: [&str; 3] = ["label", "note", "table"]; // 'card' 为 v2 预留

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

// ---------- 快照（回收站用） ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeSnapshot {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    name: String,
    sort_order: f64,
    note: Option<String>,
    cols: Vec<ColSnapshot>,
    rows: Vec<RowSnapshot>,
    cells: Vec<CellSnapshot>,
    children: Vec<NodeSnapshot>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColSnapshot {
    id: String,
    name: String,
    col_type: String,
    width: Option<i64>,
    sort_order: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowSnapshot {
    id: String,
    sort_order: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CellSnapshot {
    row_id: String,
    col_id: String,
    value: Option<String>,
}

fn snapshot_node(conn: &Connection, id: &str) -> Result<NodeSnapshot, String> {
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
    })
}

fn insert_snapshot(
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

fn count_subtree(conn: &Connection, id: &str) -> Result<usize, String> {
    let mut stmt = conn
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

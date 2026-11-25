use crate::tree::Db;
use rusqlite::params;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ---------- DTO ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColDto {
    pub id: String,
    pub name: String,
    pub col_type: String,
    pub width: Option<i64>,
    pub sort_order: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RowDto {
    pub id: String,
    pub sort_order: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CellDto {
    pub row_id: String,
    pub col_id: String,
    pub value: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridDto {
    pub cols: Vec<ColDto>,
    pub rows: Vec<RowDto>,
    pub cells: Vec<CellDto>,
}

// ---------- 辅助 ----------

/// 校验列类型（'card' 为 v2 预留，UI 不可选）
fn valid_col_type(t: &str) -> bool {
    matches!(t, "text" | "markdown")
}

/// 同步单元格的全文索引行（ref_type='cell'，ref_id="rowId:colId"）
fn fts_sync_cell(
    conn: &rusqlite::Connection,
    row_id: &str,
    col_id: &str,
    value: Option<&str>,
) -> Result<(), String> {
    let ref_id = format!("{}:{}", row_id, col_id);
    conn.execute(
        "DELETE FROM fts WHERE ref_type = 'cell' AND ref_id = ?1",
        params![ref_id],
    )
    .map_err(|e| e.to_string())?;
    if let Some(v) = value {
        if !v.trim().is_empty() {
            conn.execute(
                "INSERT INTO fts (text, ref_type, ref_id, node_id) VALUES (?1, 'cell', ?2, ?3)",
                params![v, ref_id, row_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn sibling_orders(
    conn: &rusqlite::Connection,
    table: &str,
    node_id: &str,
) -> Result<Vec<f64>, String> {
    let sql = format!(
        "SELECT sort_order FROM {} WHERE node_id = ?1 ORDER BY sort_order",
        table
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let v = stmt
        .query_map(params![node_id], |r| r.get::<_, f64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

fn order_at(orders: &[f64], index: usize) -> f64 {
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

// ---------- Commands ----------

#[tauri::command]
pub fn get_grid(state: State<Db>, node_id: String) -> Result<GridDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let is_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM node WHERE id = ?1 AND type = 'table'",
            params![node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if is_table == 0 {
        return Err("表格节点不存在".to_string());
    }

    let mut stmt = conn
        .prepare("SELECT id, name, type, width, sort_order FROM grid_col WHERE node_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map(params![node_id], |r| {
            Ok(ColDto {
                id: r.get(0)?,
                name: r.get(1)?,
                col_type: r.get(2)?,
                width: r.get(3)?,
                sort_order: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, sort_order FROM grid_row WHERE node_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![node_id], |r| {
            Ok(RowDto { id: r.get(0)?, sort_order: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT c.row_id, c.col_id, c.value FROM grid_cell c
             JOIN grid_row r ON r.id = c.row_id WHERE r.node_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let cells = stmt
        .query_map(params![node_id], |r| {
            Ok(CellDto {
                row_id: r.get(0)?,
                col_id: r.get(1)?,
                value: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(GridDto { cols, rows, cells })
}

#[tauri::command]
pub fn add_col(
    state: State<Db>,
    node_id: String,
    name: String,
    col_type: String,
    index: Option<usize>,
) -> Result<ColDto, String> {
    if !valid_col_type(&col_type) {
        return Err(format!("不支持的列类型: {}", col_type));
    }
    let name = if name.trim().is_empty() { "新列".to_string() } else { name.trim().to_string() };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let orders = sibling_orders(&conn, "grid_col", &node_id)?;
    let order = match index {
        Some(i) => order_at(&orders, i),
        None => orders.last().map(|m| m + 1000.0).unwrap_or(1000.0),
    };
    let id = new_id();
    conn.execute(
        "INSERT INTO grid_col (id, node_id, name, type, width, sort_order) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![id, node_id, name, col_type, order],
    )
    .map_err(|e| e.to_string())?;
    Ok(ColDto { id, name, col_type, width: None, sort_order: order })
}

#[tauri::command]
pub fn rename_col(state: State<Db>, col_id: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("列名不能为空".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE grid_col SET name = ?2 WHERE id = ?1", params![col_id, name.trim()])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_col_width(state: State<Db>, col_id: String, width: i64) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE grid_col SET width = ?2 WHERE id = ?1", params![col_id, width])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn del_col(state: State<Db>, col_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        conn.execute("DELETE FROM fts WHERE ref_type = 'cell' AND ref_id LIKE ('%:' || ?1)", params![col_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM grid_col WHERE id = ?1", params![col_id])
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

#[tauri::command]
pub fn add_row(state: State<Db>, node_id: String, index: Option<usize>) -> Result<RowDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let orders = sibling_orders(&conn, "grid_row", &node_id)?;
    let order = match index {
        Some(i) => order_at(&orders, i),
        None => orders.last().map(|m| m + 1000.0).unwrap_or(1000.0),
    };
    let id = new_id();
    conn.execute(
        "INSERT INTO grid_row (id, node_id, sort_order) VALUES (?1, ?2, ?3)",
        params![id, node_id, order],
    )
    .map_err(|e| e.to_string())?;
    Ok(RowDto { id, sort_order: order })
}

#[tauri::command]
pub fn del_row(state: State<Db>, row_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        conn.execute("DELETE FROM fts WHERE ref_type = 'cell' AND ref_id LIKE (?1 || ':%')", params![row_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM grid_row WHERE id = ?1", params![row_id])
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

#[tauri::command]
pub fn set_cell(
    state: State<Db>,
    row_id: String,
    col_id: String,
    value: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO grid_cell (row_id, col_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(row_id, col_id) DO UPDATE SET value = excluded.value",
        params![row_id, col_id, value],
    )
    .map_err(|e| e.to_string())?;
    fts_sync_cell(&conn, &row_id, &col_id, value.as_deref())
}

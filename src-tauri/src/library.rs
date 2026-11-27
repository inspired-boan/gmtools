//! v3 模板库/卡片库命令（DESIGN.md §8）
//!
//! 库 = 树上的 tplLib / cardLib 节点；收藏 = 深拷贝为库节点的子节点（复用快照管线）；
//! 同步 = 用来源节点当前内容覆盖库项（库项换新 id，library_meta 跟随更新）。
//! "取出到…" 直接复用现有 copy_node，无需新命令。

use crate::tree::{nearest_label_ancestor, snapshot_node, insert_snapshot, Db, NodeSnapshot};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBrief {
    pub node_id: String,
    pub name: String,
    pub rule_name: Option<String>, // 所属规则名；根级库为 None
}

fn node_type_of(conn: &rusqlite::Connection, id: &str) -> Result<String, String> {
    conn.query_row("SELECT type FROM node WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|_| "节点不存在".to_string())
}

/// 收藏：把模板/卡片深拷贝为库节点的子节点，并记录来源
#[tauri::command]
pub fn collect_to_library(
    state: State<Db>,
    item_node_id: String,
    library_node_id: String,
) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let item_type = node_type_of(&conn, &item_node_id)?;
    let lib_type = node_type_of(&conn, &library_node_id)?;
    let expected_lib = match item_type.as_str() {
        "template" => "tplLib",
        "card" => "cardLib",
        t => return Err(format!("只能收藏模板或卡片，当前是 {}", t)),
    };
    if lib_type != expected_lib {
        return Err(format!(
            "类型不匹配：模板收进模板库、卡片收进卡片库"
        ));
    }
    // 不能收藏库自身/库的子项（避免套娃）
    let src = snapshot_node(&conn, &item_node_id)?;
    if find_in_snapshot(&src, &library_node_id) {
        return Err("不能把库收藏进它自己".to_string());
    }

    // 重复收藏检查：同一来源已在该库中
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM library_meta m
             JOIN node n ON n.id = m.node_id
             WHERE m.source_node_id = ?1 AND n.parent_id = ?2",
            params![item_node_id, library_node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err("该内容已收藏到此库中".to_string());
    }

    // 库内追加位置：取库现有子项最大 sort_order
    let max_order: Option<f64> = conn
        .query_row(
            "SELECT MAX(sort_order) FROM node WHERE parent_id = ?1",
            params![library_node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut snap = src;
    snap.parent_id = None;
    snap.sort_order = max_order.map(|m| m + 1000.0).unwrap_or(1000.0);

    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = insert_snapshot(&conn, &snap, Some(&library_node_id), None, true);
    if let Err(e) = r {
        let _ = conn.execute("ROLLBACK", []);
        return Err(e);
    }
    let new_id = r.unwrap();
    conn.execute(
        "INSERT INTO library_meta (node_id, source_node_id, kind, collected_at) VALUES (?1, ?2, ?3, ?4)",
        params![new_id, item_node_id, item_type, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(new_id)
}

fn find_in_snapshot(snap: &NodeSnapshot, id: &str) -> bool {
    snap.id == id || snap.children.iter().any(|c| find_in_snapshot(c, id))
}

/// 查询库项来源
#[tauri::command]
pub fn list_library_meta(
    state: State<Db>,
    item_node_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT source_node_id, collected_at FROM library_meta WHERE node_id = ?1",
            params![item_node_id],
            |r| {
                Ok(serde_json::json!({
                    "sourceNodeId": r.get::<_, String>(0)?,
                    "collectedAt": r.get::<_, i64>(1)?,
                }))
            },
        )
        .ok();
    Ok(row)
}

/// 同步：用来源节点当前内容覆盖库项（库项换新 id，meta 跟随）
#[tauri::command]
pub fn sync_from_source(state: State<Db>, item_node_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (source_id, kind): (String, String) = conn
        .query_row(
            "SELECT source_node_id, kind FROM library_meta WHERE node_id = ?1",
            params![item_node_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "该项不是收藏项（无来源记录）".to_string())?;

    // 来源必须仍存在且类型一致
    let src_type = match node_type_of(&conn, &source_id) {
        Ok(t) => t,
        Err(_) => return Err("来源节点已被删除，无法同步".to_string()),
    };
    let expected = if kind == "template" { "template" } else { "card" };
    if src_type != expected {
        return Err("来源节点类型已变化，无法同步".to_string());
    }

    // 保留库项的父节点与排序位置
    let (parent_id, sort_order): (Option<String>, f64) = conn
        .query_row(
            "SELECT parent_id, sort_order FROM node WHERE id = ?1",
            params![item_node_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let mut snap = snapshot_node(&conn, &source_id)?;
    snap.parent_id = None;
    snap.sort_order = sort_order;

    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<String, String> {
        conn.execute("DELETE FROM node WHERE id = ?1", params![item_node_id])
            .map_err(|e| e.to_string())?;
        insert_snapshot(&conn, &snap, parent_id.as_deref(), None, true)
    })();
    let new_id = match r {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    };
    conn.execute(
        "UPDATE library_meta SET node_id = ?2 WHERE node_id = ?1",
        params![item_node_id, new_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(())
}

/// 收藏弹窗用：列出指定类型的全部库节点（按规则分组展示用）
#[tauri::command]
pub fn list_libraries(state: State<Db>, kind: String) -> Result<Vec<LibraryBrief>, String> {
    let expected_lib = match kind.as_str() {
        "template" => "tplLib",
        "card" => "cardLib",
        _ => return Err(format!("未知收藏类型: {}", kind)),
    };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM node WHERE type = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let libs = stmt
        .query_map(params![expected_lib], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for (id, name) in libs {
        let rule = nearest_label_ancestor(&conn, Some(&id))?;
        let rule_name = match rule {
            Some(rid) => conn
                .query_row("SELECT name FROM node WHERE id = ?1", params![rid], |r| r.get(0))
                .ok(),
            None => None,
        };
        out.push(LibraryBrief { node_id: id, name, rule_name });
    }
    Ok(out)
}

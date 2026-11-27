//! v3 跑团面板命令（DESIGN.md §8）。M13：摆位；M14：变量。

use crate::tree::Db;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanelItemDto {
    pub card_node_id: String,
    pub x: f64,
    pub y: f64,
}

/// 面板摆位列表（卡片内容走现有 get_card / get_tree）
#[tauri::command]
pub fn get_panel(state: State<Db>, node_id: String) -> Result<Vec<PanelItemDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let is_panel: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM node WHERE id = ?1 AND type = 'panel'",
            params![node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if is_panel == 0 {
        return Err("面板节点不存在".to_string());
    }
    let mut stmt = conn
        .prepare("SELECT card_node_id, x, y FROM panel_items WHERE node_id = ?1 ORDER BY y, x")
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(params![node_id], |r| {
            Ok(PanelItemDto {
                card_node_id: r.get(0)?,
                x: r.get(1)?,
                y: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(items)
}

/// 拖拽落点：upsert 摆位
#[tauri::command]
pub fn set_panel_item(
    state: State<Db>,
    node_id: String,
    card_node_id: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO panel_items (node_id, card_node_id, x, y) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(node_id, card_node_id) DO UPDATE SET x = excluded.x, y = excluded.y",
        params![node_id, card_node_id, x, y],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_panel_item(state: State<Db>, node_id: String, card_node_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM panel_items WHERE node_id = ?1 AND card_node_id = ?2",
        params![node_id, card_node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

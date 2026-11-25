use crate::tree::Db;
use rusqlite::params;
use tauri::State;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 同步笔记的全文索引行（ref_type='note'）
fn fts_sync_note(conn: &rusqlite::Connection, node_id: &str, content: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM fts WHERE ref_type = 'note' AND ref_id = ?1",
        params![node_id],
    )
    .map_err(|e| e.to_string())?;
    if !content.trim().is_empty() {
        conn.execute(
            "INSERT INTO fts (text, ref_type, ref_id, node_id) VALUES (?1, 'note', ?2, ?2)",
            params![content, node_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_note(state: State<Db>, node_id: String) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM node WHERE id = ?1 AND type = 'note'",
            params![node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("笔记节点不存在".to_string());
    }
    let content: String = conn
        .query_row(
            "SELECT content FROM note WHERE node_id = ?1",
            params![node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(content)
}

#[tauri::command]
pub fn save_note(state: State<Db>, node_id: String, content: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let ts = now_ms();
    conn.execute(
        "UPDATE note SET content = ?2 WHERE node_id = ?1",
        params![node_id, content],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE node SET updated_at = ?2 WHERE id = ?1",
        params![node_id, ts],
    )
    .map_err(|e| e.to_string())?;
    fts_sync_note(&conn, &node_id, &content)
}

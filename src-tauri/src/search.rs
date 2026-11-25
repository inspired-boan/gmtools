use crate::tree::Db;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub ref_type: String, // 'node' | 'note' | 'cell'
    pub ref_id: String,
    pub node_id: String,
    pub node_name: String,
    pub snippet: String, // << >> 为高亮标记，前端转为 <mark>
}

const MAX_RESULTS: usize = 50;

/// 全局搜索：≥3 字符走 trigram 索引，更短则 LIKE 扫描（自用数据量足够）。
#[tauri::command]
pub fn search(state: State<Db>, query: String) -> Result<Vec<SearchResult>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // 节点名兜底映射（fts 行可能指向已变化的单元格等）
    let node_name = |conn: &rusqlite::Connection, node_id: &str| -> String {
        conn.query_row("SELECT name FROM node WHERE id = ?1", params![node_id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_else(|_| "(已删除)".to_string())
    };

    let mut results = Vec::new();

    // 节点名匹配（LIKE 扫描，置于结果最前方便定位）
    {
        let like = format!("%{}%", q.replace('%', "").replace('_', ""));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, name FROM node WHERE name LIKE ?1 ORDER BY name LIMIT {}",
                MAX_RESULTS
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, name) = row.map_err(|e| e.to_string())?;
            results.push(SearchResult {
                ref_type: "node".to_string(),
                ref_id: id.clone(),
                node_id: id,
                node_name: name.clone(),
                snippet: name,
            });
        }
    }

    if q.chars().count() >= 3 {
        // trigram MATCH：把查询串当整体短语
        let stmt_sql = format!(
            "SELECT ref_type, ref_id, node_id, snippet(fts, 0, '<<', '>>', '…', 24)
             FROM fts WHERE fts MATCH ?1 ORDER BY rank LIMIT {}",
            MAX_RESULTS
        );
        let mut stmt = match conn.prepare(&stmt_sql) {
            Ok(s) => s,
            Err(e) => return Err(format!("搜索失败: {}", e)),
        };
        let rows = stmt
            .query_map(params![q], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (ref_type, ref_id, node_id, snippet) = row.map_err(|e| e.to_string())?;
            results.push(SearchResult {
                node_name: node_name(&conn, &node_id),
                ref_type,
                ref_id,
                node_id,
                snippet,
            });
        }
    } else {
        // LIKE 回退：手写片段
        let like = format!("%{}%", q.replace('%', "").replace('_', ""));
        let stmt_sql = format!(
            "SELECT ref_type, ref_id, node_id, text FROM fts WHERE text LIKE ?1 LIMIT {}",
            MAX_RESULTS
        );
        let mut stmt = conn.prepare(&stmt_sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (ref_type, ref_id, node_id, text) = row.map_err(|e| e.to_string())?;
            // 手写片段：命中处前后各取约 15 字符（按字符边界）
            let lower = text.to_lowercase();
            let q_lower = q.to_lowercase();
            let byte_pos = lower
                .find(&q_lower)
                .map(|p| text.floor_char_boundary(p))
                .unwrap_or(0);
            let s = text.floor_char_boundary(byte_pos.saturating_sub(15));
            let end = text.floor_char_boundary((byte_pos + q.len() + 15).min(text.len()));
            results.push(SearchResult {
                node_name: node_name(&conn, &node_id),
                ref_type,
                ref_id,
                node_id,
                snippet: text[s..end].to_string(),
            });
        }
    }

    Ok(results)
}

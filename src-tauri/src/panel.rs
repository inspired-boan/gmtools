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

// ---------- M14 共享变量 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanelVarDto {
    pub name: String,
    pub value: String,
    pub sort_order: f64,
}

#[tauri::command]
pub fn get_panel_vars(state: State<Db>, node_id: String) -> Result<Vec<PanelVarDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT name, value, sort_order FROM panel_vars WHERE node_id = ?1 ORDER BY sort_order, name")
        .map_err(|e| e.to_string())?;
    let vars = stmt
        .query_map(params![node_id], |r| {
            Ok(PanelVarDto {
                name: r.get(0)?,
                value: r.get(1)?,
                sort_order: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(vars)
}

#[tauri::command]
pub fn add_panel_var(state: State<Db>, node_id: String, name: String, value: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.starts_with('@') {
        return Err("变量名不能为空且不能以 @ 开头".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM panel_vars WHERE node_id = ?1 AND name = ?2",
            params![node_id, name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err(format!("变量 {} 已存在", name));
    }
    let max_order: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM panel_vars WHERE node_id = ?1",
            params![node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO panel_vars (node_id, name, value, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![node_id, name, value, max_order + 1000.0],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名变量：同步改写所有卡片 data 中的绑定标记（"@旧" → "@新"，整值匹配防子串误伤）
#[tauri::command]
pub fn rename_panel_var(state: State<Db>, node_id: String, old_name: String, new_name: String) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() || new_name.starts_with('@') {
        return Err("变量名不能为空且不能以 @ 开头".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        // 唯一性
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM panel_vars WHERE node_id = ?1 AND name = ?2",
                params![node_id, new_name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if dup > 0 && new_name != old_name {
            return Err(format!("变量 {} 已存在", new_name));
        }
        // 更新绑定标记：值形如 "@old" 的整值替换
        let old_marker = format!("\"@{}\"", old_name);
        let new_marker = format!("\"@{}\"", new_name);
        let affected: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT node_id FROM card WHERE data LIKE ?1")
                .map_err(|e| e.to_string())?;
            let v = stmt
                .query_map(params![format!("%\"@{}\"%", old_name)], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            v
        };
        for cid in affected {
            let data: String = conn
                .query_row("SELECT data FROM card WHERE node_id = ?1", params![cid], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let updated = data.replace(&old_marker, &new_marker);
            conn.execute("UPDATE card SET data = ?2 WHERE node_id = ?1", params![cid, updated])
                .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE panel_vars SET name = ?3 WHERE node_id = ?1 AND name = ?2",
            params![node_id, old_name, new_name],
        )
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
pub fn del_panel_var(state: State<Db>, node_id: String, name: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM panel_vars WHERE node_id = ?1 AND name = ?2",
        params![node_id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_panel_var_value(state: State<Db>, node_id: String, name: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE panel_vars SET value = ?3 WHERE node_id = ?1 AND name = ?2",
        params![node_id, name, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// +1/-1：绑变量的字段改写变量（全面板联动），普通数值改卡片数据。
/// 返回 { resolved: 新数值, var: 变量名 | null }
#[tauri::command]
pub fn bump_card_value(
    state: State<Db>,
    panel_id: String,
    card_node_id: String,
    comp_id: String,
    delta: f64,
) -> Result<serde_json::Value, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let data: String = conn
        .query_row("SELECT data FROM card WHERE node_id = ?1", params![card_node_id], |r| r.get(0))
        .map_err(|_| "卡片不存在".to_string())?;
    let mut obj: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&data).unwrap_or_default();

    let cur = obj.get(&comp_id).cloned().unwrap_or(serde_json::Value::Null);

    if let serde_json::Value::String(s) = &cur {
        if let Some(var_name) = s.strip_prefix('@') {
            if !var_name.is_empty() {
                // 绑定字段 → 改变量
                let val: String = conn
                    .query_row(
                        "SELECT value FROM panel_vars WHERE node_id = ?1 AND name = ?2",
                        params![panel_id, var_name],
                        |r| r.get(0),
                    )
                    .map_err(|_| format!("变量 {} 不存在", var_name))?;
                let num: f64 = val
                    .trim()
                    .parse()
                    .map_err(|_| format!("变量 {} 的值不是数字", var_name))?;
                let new = num + delta;
                conn.execute(
                    "UPDATE panel_vars SET value = ?3 WHERE node_id = ?1 AND name = ?2",
                    params![panel_id, var_name, format!("{}", new)],
                )
                .map_err(|e| e.to_string())?;
                return Ok(serde_json::json!({ "resolved": new, "var": var_name }));
            }
        }
    }

    // 普通数值：卡片 data 中存数字
    let num = match &cur {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        serde_json::Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| format!("字段 {} 的值不是数字，无法 ±", comp_id))?,
        _ => 0.0,
    };
    let new = num + delta;
    obj.insert(
        comp_id,
        serde_json::Value::Number(
            serde_json::Number::from_f64(new).unwrap_or(serde_json::Number::from(0)),
        ),
    );
    conn.execute(
        "UPDATE card SET data = ?2, updated_at = ?3 WHERE node_id = ?1",
        params![
            card_node_id,
            serde_json::to_string(&obj).map_err(|e| e.to_string())?,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "resolved": new, "var": null }))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

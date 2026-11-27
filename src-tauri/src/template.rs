//! v2 卡片/模板系统命令（DESIGN.md §7.4）

use crate::tree::{nearest_label_ancestor, Db};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

const SIZES: [&str; 3] = ["npc", "item", "art"];
const THEMES: [&str; 5] = ["cream", "dark", "coral", "forest", "parchment"];

// ---------- DTO ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDto {
    pub node_id: String,
    pub rule_id: Option<String>,
    pub size: String,
    pub theme: String,
    pub auto_height: bool,
    pub components: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeBrief {
    pub node_id: String,
    pub name: String,
}

fn load_template(conn: &rusqlite::Connection, node_id: &str) -> Result<TemplateDto, String> {
    conn.query_row(
        "SELECT rule_id, size, theme, components, auto_height FROM template WHERE node_id = ?1",
        params![node_id],
        |r| {
            Ok(TemplateDto {
                node_id: node_id.to_string(),
                rule_id: r.get(0)?,
                size: r.get(1)?,
                theme: r.get(2)?,
                auto_height: r.get::<_, i64>(4)? != 0,
                components: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
            })
        },
    )
    .map_err(|_| "模板不存在".to_string())
}

// ---------- 模板 ----------

#[tauri::command]
pub fn get_template(state: State<Db>, node_id: String) -> Result<TemplateDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    load_template(&conn, &node_id)
}

#[tauri::command]
pub fn save_template(
    state: State<Db>,
    node_id: String,
    size: String,
    theme: String,
    auto_height: bool,
    components: serde_json::Value,
) -> Result<usize, String> {
    if !SIZES.contains(&size.as_str()) {
        return Err(format!("未知卡片尺寸: {}", size));
    }
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("未知主题: {}", theme));
    }
    if !components.is_array() {
        return Err("组件定义必须是数组".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE template SET size = ?2, theme = ?3, components = ?4, auto_height = ?5, updated_at = ?6 WHERE node_id = ?1",
        params![
            node_id,
            size,
            theme,
            serde_json::to_string(&components).map_err(|e| e.to_string())?,
            auto_height as i64,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    let using: i64 = conn
        .query_row("SELECT COUNT(*) FROM card WHERE template_id = ?1", params![node_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(using as usize)
}

#[tauri::command]
pub fn count_cards_using(state: State<Db>, template_node_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM card WHERE template_id = ?1",
            params![template_node_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n as usize)
}

#[tauri::command]
pub fn list_cards_using(state: State<Db>, template_node_id: String) -> Result<Vec<NodeBrief>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.name FROM card c JOIN node n ON n.id = c.node_id
             WHERE c.template_id = ?1 ORDER BY n.name",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(params![template_node_id], |r| {
            Ok(NodeBrief { node_id: r.get(0)?, name: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(items)
}

/// 卡片可选模板：规则内模板 + 同规则下模板库中的模板 + 全局（NULL）模板
#[tauri::command]
pub fn list_templates_for(state: State<Db>, node_id: String) -> Result<Vec<NodeBrief>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let rule = nearest_label_ancestor(&conn, Some(&node_id))?;
    let mut out: Vec<NodeBrief> = Vec::new();

    // 1) 规则内 / 全局模板（原有逻辑）
    let mut stmt = conn
        .prepare(
            "SELECT t.node_id, n.name FROM template t JOIN node n ON n.id = t.node_id
             WHERE t.rule_id IS NULL OR t.rule_id IS ?1 ORDER BY n.name",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(params![rule], |r| {
            Ok(NodeBrief { node_id: r.get(0)?, name: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    out.extend(items);

    // 2) 同规则下模板库中的模板
    let mut stmt = conn
        .prepare("SELECT id FROM node WHERE type = 'tplLib'")
        .map_err(|e| e.to_string())?;
    let lib_ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for lib_id in lib_ids {
        let lib_rule = nearest_label_ancestor(&conn, Some(&lib_id))?;
        if lib_rule != rule {
            continue;
        }
        let mut stmt = conn
            .prepare(
                "SELECT t.node_id, n.name FROM template t JOIN node n ON n.id = t.node_id
                 WHERE n.parent_id = ?1 ORDER BY n.name",
            )
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map(params![lib_id], |r| {
                Ok(NodeBrief { node_id: r.get(0)?, name: r.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        out.extend(items);
    }

    // 去重 + 按名排序
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.node_id == b.node_id);
    Ok(out)
}

// ---------- 卡片 ----------

#[tauri::command]
pub fn get_card(state: State<Db>, node_id: String) -> Result<Option<serde_json::Value>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT template_id, data FROM card WHERE node_id = ?1",
            params![node_id],
            |r| {
                Ok(serde_json::json!({
                    "templateId": r.get::<_, String>(0)?,
                    "data": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(1)?)
                        .unwrap_or_default(),
                }))
            },
        )
        .ok();
    Ok(row)
}

#[tauri::command]
pub fn save_card(
    state: State<Db>,
    node_id: String,
    template_id: String,
    data: serde_json::Value,
) -> Result<(), String> {
    if !data.is_object() {
        return Err("卡片数据必须是对象".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tpl_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM template WHERE node_id = ?1",
            params![template_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if tpl_exists == 0 {
        return Err("模板不存在".to_string());
    }
    conn.execute(
        "INSERT INTO card (node_id, template_id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(node_id) DO UPDATE SET template_id = excluded.template_id,
           data = excluded.data, updated_at = excluded.updated_at",
        params![
            node_id,
            template_id,
            serde_json::to_string(&data).map_err(|e| e.to_string())?,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 表格卡片视图配置 ----------

#[tauri::command]
pub fn get_card_view(state: State<Db>, node_id: String) -> Result<Option<serde_json::Value>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let v = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![format!("cardview:{}", node_id)],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(v)
}

#[tauri::command]
pub fn set_card_view(state: State<Db>, node_id: String, config: Option<serde_json::Value>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let key = format!("cardview:{}", node_id);
    match config {
        Some(cfg) => {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, serde_json::to_string(&cfg).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

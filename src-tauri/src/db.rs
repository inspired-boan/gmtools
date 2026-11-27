use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

/// 打开（必要时创建）数据库并执行迁移。
/// schema 与 DESIGN.md §3 一致；迁移框架用 PRAGMA user_version 递增。
pub fn open_db(data_dir: &PathBuf) -> Result<Connection, String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("无法创建数据目录 {:?}: {}", data_dir, e))?;
    let conn = Connection::open(data_dir.join("gm.db"))
        .map_err(|e| format!("无法打开数据库: {}", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("设置 WAL 失败: {}", e))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("启用外键失败: {}", e))?;
    migrate(&conn).map_err(|e| format!("数据库迁移失败: {}", e))?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    if version < 1 {
        v1(conn).map_err(|e| format!("迁移 v1 失败: {}", e))?;
    }
    if version < 2 {
        v2(conn).map_err(|e| format!("迁移 v2 失败: {}", e))?;
    }
    if version < 3 {
        v3(conn).map_err(|e| format!("迁移 v3 失败: {}", e))?;
    }
    if version < 4 {
        v4(conn).map_err(|e| format!("迁移 v4 失败: {}", e))?;
    }
    if version < 5 {
        v5(conn).map_err(|e| format!("迁移 v5 失败: {}", e))?;
    }
    if version < 6 {
        v6(conn).map_err(|e| format!("迁移 v6 失败: {}", e))?;
    }

    conn.pragma_update(None, "user_version", 6)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// v6：库项来源元数据（v3 模板库/卡片库，DESIGN.md §8.1）
fn v6(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE library_meta (
          node_id        TEXT PRIMARY KEY,
          source_node_id TEXT NOT NULL,
          kind           TEXT NOT NULL,
          collected_at   INTEGER NOT NULL
        );
        "#,
    )
}

/// v5：模板自动高度选项
fn v5(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "ALTER TABLE template ADD COLUMN auto_height INTEGER NOT NULL DEFAULT 0;",
    )
}

/// v4：v2 卡片/模板系统（DESIGN.md §7）
fn v4(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE template (
          node_id     TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
          rule_id     TEXT,
          size        TEXT NOT NULL DEFAULT 'npc',
          theme       TEXT NOT NULL DEFAULT 'cream',
          components  TEXT NOT NULL DEFAULT '[]',
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE card (
          node_id     TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
          template_id TEXT NOT NULL,
          data        TEXT NOT NULL DEFAULT '{}',
          updated_at  INTEGER NOT NULL
        );
        "#,
    )
}

/// v3：fts 从 unicode61 换成 trigram 分词器，支持中文 ≥3 字子串匹配；
/// 短查询由 search 模块回退 LIKE 扫描。重建后从源表回填索引。
fn v3(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS fts;
        CREATE VIRTUAL TABLE fts USING fts5(
          text,
          ref_type UNINDEXED,
          ref_id   UNINDEXED,
          node_id  UNINDEXED,
          tokenize = 'trigram',
          detail   = 'none'
        );

        -- 回填笔记
        INSERT INTO fts (text, ref_type, ref_id, node_id)
        SELECT content, 'note', node_id, node_id FROM note
        WHERE trim(content) != '';

        -- 回填表格单元格
        INSERT INTO fts (text, ref_type, ref_id, node_id)
        SELECT value, 'cell', c.row_id || ':' || c.col_id, r.node_id
        FROM grid_cell c
        JOIN grid_row r ON r.id = c.row_id
        WHERE c.value IS NOT NULL AND trim(c.value) != '';
        "#,
    )
}

fn v2(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE image (
          id          TEXT PRIMARY KEY,
          ext         TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        "#,
    )
}

fn v1(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE node (
          id          TEXT PRIMARY KEY,
          parent_id   TEXT REFERENCES node(id) ON DELETE CASCADE,
          type        TEXT NOT NULL,
          name        TEXT NOT NULL,
          sort_order  REAL NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_node_parent ON node(parent_id, sort_order);

        CREATE TABLE note (
          node_id  TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
          content  TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE grid_col (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL DEFAULT 'text',
          width       INTEGER,
          sort_order  REAL NOT NULL
        );
        CREATE INDEX idx_grid_col_node ON grid_col(node_id, sort_order);

        CREATE TABLE grid_row (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
          sort_order  REAL NOT NULL
        );
        CREATE INDEX idx_grid_row_node ON grid_row(node_id, sort_order);

        CREATE TABLE grid_cell (
          row_id  TEXT NOT NULL REFERENCES grid_row(id) ON DELETE CASCADE,
          col_id  TEXT NOT NULL REFERENCES grid_col(id) ON DELETE CASCADE,
          value   TEXT,
          PRIMARY KEY (row_id, col_id)
        );

        CREATE VIRTUAL TABLE fts USING fts5(
          text,
          ref_type UNINDEXED,
          ref_id   UNINDEXED,
          node_id  UNINDEXED,
          tokenize = 'unicode61'
        );

        CREATE TABLE trash (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL,
          name        TEXT NOT NULL,
          snapshot    TEXT NOT NULL,
          deleted_at  INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        );
        "#,
    )
}

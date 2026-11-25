use crate::tree::{snapshot_node, insert_snapshot, Db, NodeSnapshot};
use base64::Engine;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

use crate::image::ImagesDir;

const NODE_FORMAT: &str = "gmtools-node";
const NODE_VERSION: i64 = 1;
const FULL_MAGIC: &str = "gmtools-full";

// ---------- 载荷 ----------

#[derive(Serialize, Deserialize)]
struct NodeExport {
    #[serde(rename = "format")]
    format: String,
    version: i64,
    exported_at: String,
    tree: NodeSnapshot,
    #[serde(default)]
    images: std::collections::BTreeMap<String, String>, // imageId(不含扩展名) -> dataURL
}

// ---------- 图片引用处理 ----------

/// 从文本中提取 gm-img:// 引用的图片 id（不含扩展名）
fn collect_image_refs(text: &str, out: &mut Vec<String>) {
    let marker = "gm-img://";
    let mut search = 0;
    while let Some(pos) = text[search..].find(marker) {
        let start = search + pos + marker.len();
        let rest = &text[start..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .unwrap_or(rest.len());
        if end > 0 {
            let raw = &rest[..end];
            if let Some(stem) = raw.rsplit_once('.').map(|(s, _)| s) {
                out.push(stem.to_string());
            }
        }
        search = start + end;
        if search >= text.len() {
            break;
        }
    }
}

fn snapshot_image_ids(snap: &NodeSnapshot) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(note) = &snap.note {
        collect_image_refs(note, &mut ids);
    }
    for c in &snap.cells {
        if let Some(v) = &c.value {
            collect_image_refs(v, &mut ids);
        }
    }
    for child in &snap.children {
        ids.extend(snapshot_image_ids(child));
    }
    ids
}

/// 把快照里 gm-img://<oldId>.ext 的图片 id 全部替换为 newId
fn remap_snapshot_images(snap: &mut NodeSnapshot, map: &std::collections::BTreeMap<String, String>) {
    let replace = |s: &mut String| {
        for (old, new) in map {
            // 引用形式: gm-img://<oldId>.<ext>
            *s = s.replace(&format!("gm-img://{}", old), &format!("gm-img://{}", new));
        }
    };
    if let Some(note) = &mut snap.note {
        replace(note);
    }
    for c in &mut snap.cells {
        if let Some(v) = &mut c.value {
            replace(v);
        }
    }
    for child in &mut snap.children {
        remap_snapshot_images(child, map);
    }
}

// ---------- Commands ----------

/// 导出单个节点（含子树）为 JSON，图片内嵌 base64
#[tauri::command]
pub fn export_node(
    state: State<Db>,
    images: State<ImagesDir>,
    node_id: String,
    path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut snap = snapshot_node(&conn, &node_id)?;
    // 导出时抹掉 parent_id（导入时由用户指定挂载点）
    snap.parent_id = None;
    drop(conn);

    let mut payload = NodeExport {
        format: NODE_FORMAT.to_string(),
        version: NODE_VERSION,
        exported_at: iso_now(),
        tree: snap,
        images: Default::default(),
    };

    let ids = snapshot_image_ids(&payload.tree);
    for stem in &ids {
        // 找到实际文件（未知扩展名则扫描）
        if let Some((file, ext)) = find_image_file(&images.0.join("images"), stem) {
            let bytes = fs::read(&file).map_err(|e| format!("读取图片失败: {}", e))?;
            let mime = crate::mime_for_ext(&ext);
            payload.images.insert(
                stem.clone(),
                format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes)),
            );
        }
    }

    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写入导出文件失败: {}", e))
}

/// 导入节点 JSON：重新分配 UUID，图片落库生成新 id
#[tauri::command]
pub fn import_node(
    state: State<Db>,
    images: State<ImagesDir>,
    path: String,
    parent_id: Option<String>,
) -> Result<String, String> {
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    let payload: NodeExport =
        serde_json::from_str(&raw).map_err(|_| "不是有效的 gmtools 节点文件".to_string())?;
    if payload.format != NODE_FORMAT {
        return Err("文件格式不匹配".to_string());
    }

    // 图片：dataURL -> 新文件 + id 映射
    let mut id_map = std::collections::BTreeMap::new();
    let img_dir = images.0.join("images");
    fs::create_dir_all(&img_dir).map_err(|e| format!("无法创建图片目录: {}", e))?;
    for (old_stem, data_url) in &payload.images {
        let new_id = Uuid::new_v4().to_string();
        let (mime, b64) = parse_data_url(data_url).ok_or("图片数据格式错误")?;
        let ext = ext_for_mime(&mime).ok_or(format!("不支持的图片格式: {}", mime))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "图片 base64 解码失败".to_string())?;
        fs::write(img_dir.join(format!("{}.{}", new_id, ext)), &bytes)
            .map_err(|e| format!("写入图片失败: {}", e))?;
        let ts = now_ms();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO image (id, ext, created_at) VALUES (?1, ?2, ?3)",
            params![new_id, ext, ts],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        id_map.insert(old_stem.clone(), new_id);
    }

    let mut tree = payload.tree;
    remap_snapshot_images(&mut tree, &id_map);
    tree.sort_order = 1000.0; // 追加到目标父节点末尾

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = &parent_id {
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM node WHERE id = ?1", params![pid], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("目标父节点不存在".to_string());
        }
    }
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let result = insert_snapshot(&conn, &tree, parent_id.as_deref(), None, true);
    if let Err(e) = result {
        let _ = conn.execute("ROLLBACK", []);
        return Err(e);
    }
    let new_id = result.unwrap();
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(new_id)
}

/// 整库导出：SQLite backup 快照 + images/ 打 zip
#[tauri::command]
pub fn export_full(
    state: State<Db>,
    images: State<ImagesDir>,
    path: String,
) -> Result<(), String> {
    // 1. backup 到临时文件
    let tmp = std::env::temp_dir().join(format!("gm_backup_{}.db", Uuid::new_v4()));
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut dst = rusqlite::Connection::open(&tmp).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(&conn, &mut dst).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|e| format!("数据库快照失败: {}", e))?;
    drop(backup);
    drop(dst);
    drop(conn);

    // 2. 打 zip
    let file = fs::File::create(&path).map_err(|e| format!("无法创建导出文件: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("gm.db", opts).map_err(|e| e.to_string())?;
    let db_bytes = fs::read(&tmp).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut zip, &db_bytes).map_err(|e| e.to_string())?;

    zip.start_file(".gmtools-full", opts).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut zip, FULL_MAGIC.as_bytes()).map_err(|e| e.to_string())?;

    let img_dir = images.0.join("images");
    if let Ok(entries) = fs::read_dir(&img_dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                let name = format!("images/{}", entry.file_name().to_string_lossy());
                zip.start_file(name, opts).map_err(|e| e.to_string())?;
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut zip, &bytes).map_err(|e| e.to_string())?;
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp);
    Ok(())
}

/// 整库导入：校验 zip → 替换数据目录 → 换上新的数据库连接
#[tauri::command]
pub fn import_full(
    state: State<Db>,
    images: State<ImagesDir>,
    path: String,
) -> Result<(), String> {
    // 1. 解压到临时目录并校验
    let extract = std::env::temp_dir().join(format!("gm_restore_{}", Uuid::new_v4()));
    fs::create_dir_all(&extract).map_err(|e| e.to_string())?;
    let file = fs::File::open(&path).map_err(|_| "无法读取备份文件".to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "不是有效的备份 zip".to_string())?;

    let mut has_db = false;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        let out_path = extract.join(&name);
        if name.ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        if name == "gm.db" {
            has_db = true;
        }
        if name == ".gmtools-full" {
            let mut magic = String::new();
            std::io::Read::read_to_string(&mut f, &mut magic).map_err(|e| e.to_string())?;
            if magic.trim() != FULL_MAGIC {
                return Err("备份文件格式不匹配".to_string());
            }
        }
    }
    if !has_db {
        return Err("备份里缺少 gm.db".to_string());
    }
    // SQLite 文件头校验
    let header = {
        let mut buf = [0u8; 16];
        let mut f = fs::File::open(extract.join("gm.db")).map_err(|e| e.to_string())?;
        std::io::Read::read_exact(&mut f, &mut buf).map_err(|_| "gm.db 文件损坏".to_string())?;
        buf
    };
    if &header[..15] != b"SQLite format 3" {
        return Err("gm.db 不是有效的 SQLite 数据库".to_string());
    }

    // 2. 校验通过：替换 images/，换连接
    let data_dir = images.0.clone();
    let new_img_dir = extract.join("images");
    let cur_img_dir = data_dir.join("images");
    let _ = fs::remove_dir_all(&cur_img_dir);
    if new_img_dir.exists() {
        fs::rename(&new_img_dir, &cur_img_dir).or_else(|_| {
            fs::create_dir_all(&cur_img_dir)?;
            for entry in fs::read_dir(&new_img_dir)?.flatten() {
                fs::copy(entry.path(), cur_img_dir.join(entry.file_name()))?;
            }
            Ok(())
        }).map_err(|e: std::io::Error| format!("替换图片目录失败: {}", e))?;
    }

    // 3. 把新库放到正式位置（清掉旧 WAL 残留），换上新连接
    let db_path = data_dir.join("gm.db");
    let _ = fs::remove_file(data_dir.join("gm.db-wal"));
    let _ = fs::remove_file(data_dir.join("gm.db-shm"));
    fs::copy(extract.join("gm.db"), &db_path)
        .map_err(|e| format!("替换数据库文件失败: {}", e))?;

    let new_conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("打开新库失败: {}", e))?;
    new_conn
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    new_conn
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    use std::mem::swap;
    swap(&mut *conn, &mut { new_conn });
    drop(conn);

    // 清理临时解压目录
    let _ = fs::remove_dir_all(&extract);
    Ok(())
}

/// 打开数据文件夹
#[tauri::command]
pub fn open_data_dir(images: State<ImagesDir>) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(images.0.as_os_str())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 工具 ----------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn iso_now() -> String {
    // 简化 ISO 时间：无需完整时区处理，仅用于记录导出时刻
    let secs = now_ms() / 1000;
    format!("{}Z", secs)
}

fn find_image_file(dir: &Path, stem: &str) -> Option<(PathBuf, String)> {
    for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
        let p = dir.join(format!("{}.{}", stem, ext));
        if p.exists() {
            return Some((p, ext.to_string()));
        }
    }
    None
}

fn parse_data_url(data_url: &str) -> Option<(String, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, b64) = rest.split_once(";base64,")?;
    Some((mime.to_string(), b64))
}

fn ext_for_mime(mime: &str) -> Option<String> {
    match mime {
        "image/png" => Some("png".to_string()),
        "image/jpeg" => Some("jpg".to_string()),
        "image/gif" => Some("gif".to_string()),
        "image/webp" => Some("webp".to_string()),
        _ => None,
    }
}

mod db;
mod export;
mod grid;
mod image;
mod note;
mod search;
mod tree;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::http::Response;
use tauri::Manager;

fn http_resp(status: u16, mime: Option<&str>, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    let mut b = Response::builder().status(status);
    if let Some(m) = mime {
        b = b.header("Content-Type", m);
    }
    b.body(Cow::Owned(body)).expect("构建 HTTP 响应失败")
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // gm-img://<id>.<ext> → 数据目录 images/ 下的文件
        // Windows 下实际访问为 http(s)://gm-img.localhost/<id>.<ext>
        .register_uri_scheme_protocol("gm-img", move |_ctx, request| {
            let raw = request.uri().path().trim_start_matches('/').to_string();
            let ok = !raw.is_empty()
                && raw
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                && raw.matches('.').count() == 1;
            if !ok {
                return http_resp(400, None, Vec::new());
            }
            let data_dir = _ctx
                .app_handle()
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let ext = raw.rsplit('.').next().unwrap_or("");
            match std::fs::read(data_dir.join("images").join(&raw)) {
                Ok(bytes) => http_resp(200, Some(mime_for_ext(ext)), bytes),
                Err(_) => http_resp(404, None, Vec::new()),
            }
        })
        .setup(|app| {
            let data_dir: PathBuf = app.path().app_data_dir()?;
            let conn = db::open_db(&data_dir).map_err(std::io::Error::other)?;
            app.manage(tree::Db(Mutex::new(conn)));
            app.manage(image::ImagesDir(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tree::get_tree,
            tree::create_node,
            tree::rename_node,
            tree::move_node,
            tree::copy_node,
            tree::delete_node,
            tree::get_setting,
            tree::set_setting,
            tree::list_trash,
            tree::restore_from_trash,
            tree::purge_trash,
            note::get_note,
            note::save_note,
            image::save_image,
            grid::get_grid,
            grid::add_col,
            grid::rename_col,
            grid::set_col_width,
            grid::del_col,
            grid::add_row,
            grid::del_row,
            grid::set_cell,
            search::search,
            export::export_node,
            export::import_node,
            export::export_full,
            export::import_full,
            export::open_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("gmtools 启动失败");
}

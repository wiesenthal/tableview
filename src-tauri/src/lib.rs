#[cfg(test)]
mod bench;
mod chat;
mod config;
mod db;
mod edits;
#[cfg(test)]
mod itest;
mod mcp;
mod results;
mod state;
mod updates;

use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use config::{ChatSettings, ConnectionConfig};
use results::QueryResult;
use state::AppState;

type Res<T> = Result<T, String>;
type St<'a> = State<'a, Arc<AppState>>;

fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[tauri::command]
fn list_connections(state: St<'_>) -> Vec<ConnectionConfig> {
    state.connections.lock().unwrap().clone()
}

#[tauri::command]
async fn save_connection(
    state: St<'_>,
    config: ConnectionConfig,
    password: Option<String>,
) -> Res<ConnectionConfig> {
    let mut cfg = config;
    if cfg.id.is_empty() {
        cfg.id = format!("conn-{}", uuid::Uuid::new_v4().simple());
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        config::set_password(&cfg.id, &p).map_err(e)?;
    }
    {
        let mut list = state.connections.lock().unwrap();
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(c) => *c = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        state.store.save_connections(&list).map_err(e)?;
    }
    state.disconnect(&cfg.id).await;
    Ok(cfg)
}

#[tauri::command]
async fn delete_connection(state: St<'_>, id: String) -> Res<()> {
    state.disconnect(&id).await;
    config::delete_password(&id);
    let mut list = state.connections.lock().unwrap();
    list.retain(|c| c.id != id);
    state.store.save_connections(&list).map_err(e)
}

#[tauri::command]
async fn test_connection(config: ConnectionConfig, password: Option<String>) -> Res<String> {
    let pw = match password.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => {
            let id = config.id.clone();
            tokio::task::spawn_blocking(move || config::get_password(&id))
                .await
                .map_err(e)?
        }
    };
    let (pool, version) = db::connect(&config, pw.as_deref()).await.map_err(e)?;
    pool.close().await;
    Ok(version)
}

#[tauri::command]
async fn connect(state: St<'_>, id: String) -> Res<String> {
    state.pool(&id).await.map_err(e)?;
    Ok(state
        .versions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
async fn disconnect(state: St<'_>, id: String) -> Res<()> {
    state.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
async fn get_schema(state: St<'_>, id: String) -> Res<db::SchemaTree> {
    state
        .pool(&id)
        .await
        .map_err(e)?
        .schema_tree()
        .await
        .map_err(e)
}

#[tauri::command]
async fn describe_table(
    state: St<'_>,
    id: String,
    schema: String,
    table: String,
) -> Res<db::TableStructure> {
    state.structure(&id, &schema, &table).await.map_err(e)
}

#[tauri::command]
async fn browse_table(
    state: St<'_>,
    id: String,
    schema: String,
    table: String,
    opts: db::BrowseOptions,
) -> Res<QueryResult> {
    state.browse(&id, &schema, &table, &opts).await.map_err(e)
}

#[tauri::command]
async fn count_rows(
    state: St<'_>,
    id: String,
    schema: String,
    table: String,
    opts: db::BrowseOptions,
) -> Res<i64> {
    state
        .count(&id, &schema, &table, &opts.filters)
        .await
        .map_err(e)
}

/// A failed editor query. `position` is the 1-based character offset into the
/// submitted SQL where Postgres located the error.
#[derive(Serialize)]
struct QueryError {
    message: String,
    position: Option<usize>,
}

#[tauri::command]
async fn run_query(
    state: St<'_>,
    id: String,
    tab_id: String,
    sql: String,
    query_id: String,
) -> Result<QueryResult, QueryError> {
    state
        .run_editor_query(&id, &tab_id, &sql, &query_id)
        .await
        .map_err(|err| {
            let message = db::error_message(&err).unwrap_or_else(|| {
                let m = err.to_string();
                m.strip_prefix("error returned from database: ")
                    .map(str::to_string)
                    .unwrap_or(m)
            });
            QueryError {
                message,
                position: db::error_position(&err),
            }
        })
}

#[tauri::command]
async fn cancel_query(state: St<'_>, query_id: String) -> Res<bool> {
    state.cancel(&query_id).await.map_err(e)
}

#[tauri::command]
fn close_tab(state: St<'_>, id: String, tab_id: String) {
    state.close_tab_session(&id, &tab_id);
}

#[tauri::command]
async fn get_result_arrow(state: St<'_>, result_id: String) -> Res<tauri::ipc::Response> {
    let s = state
        .results
        .get(&result_id)
        .ok_or("result expired; run it again")?;
    Ok(tauri::ipc::Response::new(s.ipc.to_vec()))
}

#[tauri::command]
fn get_result_meta(state: St<'_>, result_id: String) -> Res<QueryResult> {
    Ok(state
        .results
        .get(&result_id)
        .ok_or("result expired; run it again")?
        .meta
        .clone())
}

#[tauri::command]
fn release_result(state: St<'_>, result_id: String) {
    state.results.release(&result_id);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn commit_changes(
    state: St<'_>,
    id: String,
    schema: String,
    table: String,
    result_id: Option<String>,
    changes: edits::Changes,
    dry_run: bool,
) -> Res<edits::CommitOutcome> {
    let cfg = state.config(&id).map_err(e)?;
    if cfg.read_only {
        return Err("this connection is read-only".into());
    }
    let pool = state.pool(&id).await.map_err(e)?;
    let st = pool.describe(&schema, &table).await.map_err(e)?;
    let batch = match &result_id {
        Some(r) => {
            let s = state
                .results
                .get(r)
                .ok_or("the loaded rows expired; refresh and edit again")?;
            if s.meta.table.as_ref() != Some(&(schema.clone(), table.clone())) {
                return Err("these rows did not come from this table".into());
            }
            Some(s.batch().map_err(e)?)
        }
        None => None,
    };
    let stmts =
        edits::plan(pool.kind(), &schema, &table, &st, batch.as_ref(), &changes).map_err(e)?;
    let statements = edits::preview(&stmts);
    if dry_run {
        return Ok(edits::CommitOutcome {
            statements,
            rows_affected: 0,
        });
    }
    let rows_affected = edits::execute(&pool, &stmts).await.map_err(e)?;
    Ok(edits::CommitOutcome {
        statements,
        rows_affected,
    })
}

#[derive(Serialize)]
struct McpInfo {
    url: String,
    token: String,
    status: String,
    claude_command: String,
    claude_found: Option<String>,
}

#[tauri::command]
fn mcp_info(state: St<'_>) -> McpInfo {
    let s = state.settings.lock().unwrap().clone();
    let url = format!("http://127.0.0.1:{}/mcp", s.mcp_port);
    McpInfo {
        claude_command: format!(
            "claude mcp add --transport http --scope user tableview {url} --header \"Authorization: Bearer {}\"",
            s.mcp_token
        ),
        url,
        token: s.mcp_token,
        status: state.mcp_status.lock().unwrap().clone(),
        claude_found: chat::find_claude(&s.chat.claude_path).map(|p| p.display().to_string()),
    }
}

#[tauri::command]
fn get_chat_settings(state: St<'_>) -> ChatSettings {
    state.settings.lock().unwrap().chat.clone()
}

#[tauri::command]
fn save_chat_settings(state: St<'_>, chat: ChatSettings) -> Res<()> {
    let mut s = state.settings.lock().unwrap();
    // Checked when they change, so a stale stored value never blocks saving
    // something else (the panel width). Launch checks them again regardless.
    if chat.claude_path != s.chat.claude_path {
        chat::check_claude_path(&chat.claude_path).map_err(e)?;
    }
    if chat.model != s.chat.model && !chat.model.trim().is_empty() {
        chat::safe_arg("model", chat.model.trim()).map_err(e)?;
    }
    s.chat = chat;
    state.store.save_settings(&s).map_err(e)
}

#[tauri::command]
async fn chat_start(
    state: St<'_>,
    chats: State<'_, chat::Chats>,
    conversation: String,
    resume: Option<String>,
) -> Res<()> {
    chats
        .start(state.inner().clone(), &conversation, resume)
        .await
        .map_err(e)
}

#[tauri::command]
async fn chat_send(
    chats: State<'_, chat::Chats>,
    conversation: String,
    text: String,
    images: Option<Vec<chat::Image>>,
) -> Res<()> {
    chats
        .send(&conversation, &text, &images.unwrap_or_default())
        .await
        .map_err(e)
}

#[tauri::command]
async fn chat_interrupt(chats: State<'_, chat::Chats>, conversation: String) -> Res<()> {
    chats.interrupt(&conversation).await.map_err(e)
}

#[tauri::command]
async fn chat_stop(chats: State<'_, chat::Chats>, conversation: String) -> Res<()> {
    chats.stop(&conversation).await;
    Ok(())
}

#[tauri::command]
fn get_prefs(state: St<'_>) -> serde_json::Map<String, serde_json::Value> {
    state.settings.lock().unwrap().prefs.clone()
}

#[tauri::command]
fn save_prefs(state: St<'_>, prefs: serde_json::Map<String, serde_json::Value>) -> Res<()> {
    let mut s = state.settings.lock().unwrap();
    s.prefs = prefs;
    state.store.save_settings(&s).map_err(e)
}

#[tauri::command]
async fn claude_auth_status(state: St<'_>) -> Res<chat::AuthStatus> {
    Ok(chat::auth_status(&state).await)
}

#[tauri::command]
async fn claude_login(state: St<'_>, chats: State<'_, chat::Chats>) -> Res<()> {
    chats.login(state.inner().clone()).await.map_err(e)
}

#[tauri::command]
async fn claude_login_code(chats: State<'_, chat::Chats>, code: String) -> Res<()> {
    chats.login_code(&code).await.map_err(e)
}

type Fb<'a> = State<'a, Arc<updates::Feedback>>;

#[tauri::command]
fn feedback_list(state: St<'_>, fb: Fb<'_>) -> Vec<updates::Item> {
    fb.list(&state)
}

#[tauri::command]
async fn feedback_retry(state: St<'_>, fb: Fb<'_>, id: String) -> Res<usize> {
    fb.inner()
        .retry(state.inner().clone(), &id)
        .await
        .map_err(e)
}

#[tauri::command]
async fn feedback_readiness(state: St<'_>, fb: Fb<'_>) -> Res<updates::Readiness> {
    Ok(fb.readiness(&state).await)
}

#[tauri::command]
async fn feedback_submit(
    state: St<'_>,
    fb: Fb<'_>,
    text: String,
    images: Option<Vec<chat::Image>>,
) -> Res<updates::Item> {
    fb.inner()
        .submit(
            state.inner().clone(),
            text,
            images.unwrap_or_default(),
            None,
        )
        .await
        .map_err(e)
}

#[tauri::command]
async fn feedback_check(state: St<'_>, fb: Fb<'_>) -> Res<usize> {
    fb.inner().check(state.inner().clone()).await.map_err(e)
}

#[tauri::command]
async fn feedback_rebuild(state: St<'_>, fb: Fb<'_>) -> Res<()> {
    fb.inner().rebuild(state.inner().clone()).await.map_err(e)
}

#[tauri::command]
fn feedback_remove(state: St<'_>, fb: Fb<'_>, id: String) {
    fb.remove(&state, &id);
}

#[tauri::command]
async fn update_restart(app: tauri::AppHandle, state: St<'_>) -> Res<()> {
    updates::install_build(&state).await.map_err(e)?;
    app.restart();
}

#[tauri::command]
fn get_update_settings(state: St<'_>) -> serde_json::Value {
    let s = state.settings.lock().unwrap().updates.clone();
    serde_json::json!({
        "source_dir": s.source_dir,
        "signing_identity": s.signing_identity,
        "auto_merge": s.auto_merge,
        "default_source_dir": updates::source_dir(&state).display().to_string(),
    })
}

#[tauri::command]
fn save_update_settings(
    state: St<'_>,
    source_dir: String,
    signing_identity: String,
    auto_merge: bool,
) -> Res<()> {
    let mut s = state.settings.lock().unwrap();
    s.updates.source_dir = source_dir.trim().to_string();
    s.updates.signing_identity = signing_identity.trim().to_string();
    s.updates.auto_merge = auto_merge;
    state.store.save_settings(&s).map_err(e)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    updates::mark_start();
    // A separate data folder (TABLEVIEW_DATA_DIR) is a separate instance, so a
    // demo or test copy can run beside the everyday one.
    let separate = std::env::var("TABLEVIEW_DATA_DIR").is_ok_and(|d| !d.is_empty());
    let mut builder = tauri::Builder::default();
    if !separate {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = match std::env::var("TABLEVIEW_DATA_DIR") {
                Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            let state = Arc::new(AppState::new(config::Store::new(dir)?)?);
            let _ = state.app.set(app.handle().clone());
            app.manage(state.clone());
            app.manage(chat::Chats::default());
            let feedback = Arc::new(updates::Feedback::default());
            feedback.start_polling(state.clone());
            app.manage(feedback);
            tauri::async_runtime::spawn(mcp::serve(state));
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};
                let _ = apply_vibrancy(&w, NSVisualEffectMaterial::Sidebar, None, None);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            test_connection,
            connect,
            disconnect,
            get_schema,
            describe_table,
            browse_table,
            count_rows,
            run_query,
            cancel_query,
            close_tab,
            get_result_arrow,
            get_result_meta,
            release_result,
            commit_changes,
            mcp_info,
            get_chat_settings,
            save_chat_settings,
            chat_start,
            chat_send,
            chat_interrupt,
            chat_stop,
            claude_auth_status,
            claude_login,
            claude_login_code,
            get_prefs,
            save_prefs,
            feedback_list,
            feedback_readiness,
            feedback_submit,
            feedback_retry,
            feedback_check,
            feedback_rebuild,
            feedback_remove,
            update_restart,
            get_update_settings,
            save_update_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running TableView");
}

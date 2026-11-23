#[cfg(not(mobile))]
mod ai;
#[cfg(not(mobile))]
mod database;
#[cfg(not(mobile))]
mod exercises;
#[cfg(not(mobile))]
mod notes;
#[cfg(not(mobile))]
mod questions;

#[cfg(any(mobile, test))]
mod mobile;

#[cfg(not(mobile))]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(ai::AiState::default()))
        .manage(notes::NotesState::default())
        .manage(exercises::PracticeWindows::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            database::initialize_database,
            exercises::save_practice_settings,
            exercises::create_exercise,
            exercises::open_practice_window,
            exercises::load_exercise_session,
            exercises::save_exercise_draft,
            exercises::prepare_study_reviews,
            exercises::close_exercise_session,
            notes::extract_note_topics,
            notes::fetch_obsidian_notes,
            notes::resolve_note_issue,
            notes::set_note_studying,
            questions::get_question_generation_note,
            questions::save_generated_questions,
            questions::manage_note_questions,
            ai::prompt_ai,
            ai::oauth::connect_openai_oauth,
            ai::oauth::cancel_openai_oauth,
            ai::oauth::get_openai_oauth_account,
            ai::oauth::disconnect_openai_oauth,
            ai::oauth::list_openai_oauth_models,
            ai::get_ai_configuration,
            ai::save_ai_integration,
            ai::select_ai_integration,
            ai::remove_ai_integration,
            ai::list_ai_models,
            ai::discover_ai_models,
            ai::get_last_ai_response,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Obstudy");
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .manage(mobile::MobileStorage::default())
        .invoke_handler(tauri::generate_handler![
            mobile::mobile_load_state,
            mobile::mobile_save_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Obstudy mobile");
}

use arboard::Clipboard;

use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn clipboard_read_text() -> AppResult<String> {
    std::thread::Builder::new()
        .name("clipboard-read".into())
        .spawn(read_text)
        .map_err(|e| AppError::msg(e.to_string()))?
        .join()
        .map_err(|_| AppError::msg("clipboard thread panicked"))?
}

fn read_text() -> AppResult<String> {
    let mut clipboard = Clipboard::new().map_err(|e| AppError::msg(e.to_string()))?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(err) => Err(AppError::msg(err.to_string())),
    }
}

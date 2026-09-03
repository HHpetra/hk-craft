use arboard::Clipboard;

use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn clipboard_read_text() -> AppResult<String> {
    spawn_clipboard("clipboard-read", read_text)
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> AppResult<()> {
    spawn_clipboard("clipboard-write", move || write_text(&text))
}

fn spawn_clipboard<T: Send + 'static>(
    name: &'static str,
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(work)
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

fn write_text(text: &str) -> AppResult<()> {
    let mut clipboard = Clipboard::new().map_err(|e| AppError::msg(e.to_string()))?;
    clipboard
        .set_text(text)
        .map_err(|err| AppError::msg(err.to_string()))
}

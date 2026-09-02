use serde::Deserialize;

use crate::error::{AppError, AppResult};

const USER_AGENT: &str = "HK-Craft (https://github.com/HHpetra/hk-craft)";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

fn is_github_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) => {
            !owner.is_empty()
                && !name.is_empty()
                && owner
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        }
        _ => false,
    }
}

fn fetch_tag(repo: &str) -> AppResult<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|err| AppError::msg(format!("检查更新失败：{err}")))?;
    let release: Release = response
        .into_json()
        .map_err(|err| AppError::msg(format!("无法解析 GitHub 响应：{err}")))?;
    let tag = release.tag_name.trim();
    if tag.is_empty() {
        return Err(AppError::msg("GitHub Release 没有 tag"));
    }
    Ok(tag.to_string())
}

#[tauri::command]
pub fn fetch_latest_release_tag(repo: String) -> AppResult<String> {
    if !is_github_repo(&repo) {
        return Err(AppError::msg("无效的仓库"));
    }
    std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || fetch_tag(&repo))
        .map_err(|err| AppError::msg(err.to_string()))?
        .join()
        .map_err(|_| AppError::msg("update-check thread panicked"))?
}

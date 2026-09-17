fn main() {
    // Windows embeds icon.ico via winres; cargo must rebuild when the ICO changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/256x256.png");
    // Incremental `tauri build` otherwise reuses a binary whose embedded
    // frontend map is empty → runtime "asset not found: index.html".
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../dist/index.html");

    let profile = std::env::var("PROFILE").unwrap_or_default();
    let index = std::path::Path::new("../dist/index.html");
    if profile == "release" && !index.exists() {
        panic!(
            "release build missing {index} — run `pnpm build:ui` (or `pnpm tauri build`) so frontend assets are embedded",
            index = index.display()
        );
    }

    tauri_build::build()
}

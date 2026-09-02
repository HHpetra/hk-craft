fn main() {
    // Windows embeds icon.ico via winres; cargo must rebuild when the ICO changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/256x256.png");
    tauri_build::build()
}

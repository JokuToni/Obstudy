fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=ai-migrations");
    tauri_build::build()
}

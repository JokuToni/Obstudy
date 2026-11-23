fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=ai-migrations");
    println!("cargo:rerun-if-changed=mobile-migrations");
    tauri_build::build()
}

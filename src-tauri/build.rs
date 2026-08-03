use std::path::Path;

fn track_frontend_files(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());

    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            track_frontend_files(&entry_path);
        } else {
            println!("cargo:rerun-if-changed={}", entry_path.display());
        }
    }
}

fn main() {
    track_frontend_files(Path::new("../dist-stable"));
    tauri_build::build()
}

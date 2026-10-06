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

    // 把附加客户端内嵌进主程序，使发布版只需一个 exe。
    //
    // 两个 bin 的编译顺序 Cargo 不保证，客户端可能还没编出来，所以这里的内嵌
    // 完全是可选的：release 版优先用 target/release/ 下的，其次是上次 debug
    // 留下的，两者都没有就把 ATTACH_CLIENT_BYTES 留空，主程序退回「同目录查找」
    // 的老行为。绝不让构建因为找不到客户端而失败。
    // 内嵌与当前 profile 匹配的那份客户端：debug 构建嵌 debug 版、release 嵌
    // release 版，避免开发时内嵌进一个旧的 release 二进制。profile 从 Cargo 给
    // 的 OPT_LEVEL / DEBUG 推断不到可靠名字，直接用 PROFILE 环境变量。
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let client = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(&profile)
        .join("slateterm-attach.exe");

    // include_bytes! 只接受字面量，喂不了 option_env! 的编译期常量。所以由这里
    // 生成一个内含 include_bytes! 的源码片段，路径在生成时已写死。
    // 找不到客户端时生成空片段（而不是不生成），remote.rs 那边的 include! 才能
    // 无条件编译，不需要 #[cfg] 分支。
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
    let snippet = std::path::Path::new(&out_dir).join("attach_client_bytes.rs");
    let generated = match &client {
        path if path.is_file() => {
            // 内嵌后客户端更新要能触发主程序重编，否则改了客户端主程序不会变
            println!("cargo:rerun-if-changed={}", path.display());
            format!(
                "pub const ATTACH_CLIENT_BYTES: &[u8] = include_bytes!(r#\"{}\"#);\n",
                path.display()
            )
        }
        _ => {
            // 两个 bin 的编译顺序 Cargo 不保证，客户端可能还没编出来；也可能是在
            // CI 上首次构建。此时不内嵌，主程序退回「同目录查找」，构建照常成功。
            println!(
                "cargo:warning=slateterm-attach.exe not found in target/{profile}; building without an embedded attach client"
            );
            "pub const ATTACH_CLIENT_BYTES: &[u8] = &[];\n".to_string()
        }
    };
    if let Err(error) = std::fs::write(&snippet, generated) {
        // 生成失败会让 include! 找不到文件从而构建失败；退一步写空片段
        println!("cargo:warning=could not write {snippet:?}: {error}");
        let _ = std::fs::write(&snippet, "pub const ATTACH_CLIENT_BYTES: &[u8] = &[];\n");
    }

    tauri_build::build()
}

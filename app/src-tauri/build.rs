//! 构建脚本。
//!
//! 可选：构建时设置环境变量 DESKCALENDAR_OAUTH_CLIENT 指向 OAuth 客户端 JSON 文件，
//! 会把它嵌入程序，新电脑装好后直接登录即可，不用再手动复制客户端文件。
//! 只用于自己分发的安装包；不要把嵌入了客户端的安装包公开发布。客户端文件本身不进仓库。

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=DESKCALENDAR_OAUTH_CLIENT");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("缺少 OUT_DIR")).join("embedded_oauth_client.json");
    let content = match std::env::var("DESKCALENDAR_OAUTH_CLIENT") {
        Ok(path) if !path.trim().is_empty() => {
            println!("cargo:rerun-if-changed={path}");
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 DESKCALENDAR_OAUTH_CLIENT 指定的文件失败（{path}）：{e}"));
            // 构建时就检查格式，避免装到别的电脑上才发现不能用
            let json: serde_json::Value = serde_json::from_str(&text).expect("OAuth 客户端文件不是合法的 JSON");
            assert!(json.get("installed").is_some(), "OAuth 客户端文件需要是“桌面应用”类型（含 installed 段）");
            text
        }
        _ => String::new(),
    };
    std::fs::write(out, content).expect("写入嵌入的 OAuth 客户端失败");
    tauri_build::build()
}

use std::path::Path;

fn main() {
    embed_locales();
    tauri_build::build()
}

/// Every locales/<code>.json is compiled in (src/i18n.rs), so adding a
/// language to the tray menu is adding its file.
fn embed_locales() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("locales");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut codes: Vec<String> = std::fs::read_dir(&dir)
        .expect("app/src-tauri/locales")
        .filter_map(|e| {
            let p = e.ok()?.path();
            println!("cargo:rerun-if-changed={}", p.display());
            (p.extension()? == "json").then(|| p.file_stem()?.to_str().map(String::from))?
        })
        .collect();
    codes.sort();
    let body: String = codes
        .iter()
        .map(|c| format!("    ({c:?}, include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/locales/{c}.json\"))),\n"))
        .collect();
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("locales.rs");
    std::fs::write(out, format!("pub static LOCALES: &[(&str, &str)] = &[\n{body}];\n")).unwrap();
}

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 64 * 1024 * 1024;

fn resource_path(project: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.len() > 1024
        || relative.contains(['\\', ':'])
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || relative.chars().any(char::is_control)
    {
        return Err("素材必须使用工程目录内的相对路径".into());
    }
    let base = project
        .parent()
        .ok_or("工程目录无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = base.join(relative);
    let existing = target
        .ancestors()
        .find(|p| p.exists())
        .ok_or("素材目录无效")?;
    if !existing
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&base)
    {
        return Err("素材路径超出工程目录".into());
    }
    Ok(target)
}

pub fn hydrate(
    path: &Path,
    content: &str,
    mut relocate: impl FnMut(&str) -> Result<PathBuf, String>,
) -> Result<String, String> {
    let mut data: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let mut total = content.len() as u64;
    let mut changed = false;
    if let Some(assets) = data["edits"]["assets"].as_array_mut() {
        if assets.len() > 139 {
            return Err("素材数量超出限制".into());
        }
        for asset in assets {
            if asset["source"]["kind"] != "relative" {
                continue;
            }
            let relative = asset["source"]["path"].as_str().ok_or("素材路径无效")?;
            let requested = resource_path(path, relative)?;
            let label = format!(
                "{} ({relative})",
                asset["source"]["name"].as_str().unwrap_or("素材")
            );
            let target = if requested.is_file() {
                requested
            } else {
                relocate(&label)?
            };
            let mut source = String::new();
            File::open(&target)
                .map_err(|e| format!("读取素材失败：{e}"))?
                .take(MAX_BYTES.saturating_sub(total) + 1)
                .read_to_string(&mut source)
                .map_err(|e| format!("读取素材失败：{e}"))?;
            total += source.len() as u64;
            if total > MAX_BYTES {
                return Err("工程及素材不能超过 64 MB".into());
            }
            let source: serde_json::Value =
                serde_json::from_str(&source).map_err(|e| format!("素材文件无效：{e}"))?;
            if source["kind"] != "embedded" {
                return Err("请选择原工程导出的 .plyasset 素材文件".into());
            }
            asset["source"] = source;
            changed = true;
        }
    }
    if changed {
        serde_json::to_string(&data).map_err(|e| e.to_string())
    } else {
        Ok(content.to_owned())
    }
}

pub fn externalize(path: &Path, content: &str) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let mut data: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let mut changed = false;
    if let Some(assets) = data["edits"]["assets"].as_array_mut() {
        for asset in assets {
            if asset["source"]["kind"] != "embedded" {
                continue;
            }
            let source = serde_json::to_string(&asset["source"]).map_err(|e| e.to_string())?;
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            source.hash(&mut hash);
            let directory = format!(
                "{}.assets",
                path.file_stem().ok_or("工程文件名无效")?.to_string_lossy()
            );
            let relative = format!("{directory}/{:016x}.plyasset", hash.finish());
            let target = resource_path(path, &relative)?;
            fs::create_dir_all(target.parent().ok_or("素材目录无效")?)
                .map_err(|e| e.to_string())?;
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut file) => {
                    let result = file
                        .write_all(source.as_bytes())
                        .and_then(|_| file.sync_all());
                    drop(file);
                    if let Err(error) = result {
                        let _ = fs::remove_file(&target);
                        return Err(format!("写入素材失败，原工程保持不变：{error}"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let mut existing = Vec::new();
                    File::open(&target)
                        .map_err(|e| e.to_string())?
                        .take(source.len() as u64 + 1)
                        .read_to_end(&mut existing)
                        .map_err(|e| e.to_string())?;
                    if existing != source.as_bytes() {
                        return Err("素材文件冲突或损坏，原工程保持不变，请另存工程".into());
                    }
                }
                Err(error) => return Err(format!("写入素材失败：{error}")),
            }
            asset["source"] = serde_json::json!({ "kind": "relative", "path": relative, "name": asset["source"]["name"] });
            changed = true;
        }
    }
    if changed {
        serde_json::to_string(&data).map_err(|e| e.to_string())
    } else {
        Ok(content.to_owned())
    }
}

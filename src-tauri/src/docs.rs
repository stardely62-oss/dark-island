//! Documents attached in the chat are read here, on the computer, and sent
//! to the model as text: PDF, Word, Excel, PowerPoint, and plain text files.

use std::io::Read;
use std::path::Path;

const LIMIT: usize = 60_000;

fn cut(mut s: String) -> String {
    if s.chars().count() > LIMIT {
        s = s.chars().take(LIMIT).collect::<String>() + "\n…(дальше обрезано)";
    }
    s
}

/// Text of the XML parts of an Office file, tags dropped, paragraphs kept.
fn office_text(path: &Path, parts: impl Fn(&str) -> bool, para: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "Файл повреждён или это не документ Office".to_string())?;
    let mut names: Vec<String> = zip.file_names().filter(|n| parts(n)).map(str::to_string).collect();
    // slide2 after slide1, not after slide19
    names.sort_by_key(|n| {
        let digits: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
        (digits.parse::<u64>().unwrap_or(0), n.clone())
    });
    let mut out = String::new();
    for n in names {
        let mut xml = String::new();
        if zip.by_name(&n).map_err(|e| e.to_string())?.read_to_string(&mut xml).is_err() {
            continue;
        }
        out.push_str(&strip_xml(&xml, para));
        out.push('\n');
    }
    Ok(out)
}

fn strip_xml(xml: &str, para: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut rest = xml;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else { break };
        let tag = &rest[i + 1..i + j];
        if tag.starts_with(&format!("/{para}")) || tag.starts_with("w:br") || tag.starts_with("a:br") {
            out.push('\n');
        } else if tag.starts_with("/c>") || tag == "/c" || tag.starts_with("w:tab") {
            out.push('\t');
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

pub fn read(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let text = match ext.as_str() {
        "pdf" => {
            let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
            pdf_extract::extract_text_from_mem(&bytes).map_err(|_| "Не удалось прочитать PDF".to_string())?
        }
        "docx" => office_text(p, |n| n == "word/document.xml", "w:p")?,
        "pptx" => office_text(p, |n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"), "a:p")?,
        "xlsx" => office_text(p, |n| n == "xl/sharedStrings.xml" || (n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml")), "row")?,
        _ => {
            let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
            if bytes.iter().take(4096).any(|&b| b == 0) {
                return Err("Это не текстовый файл".into());
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    let text = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n");
    if text.trim().is_empty() {
        return Err("В файле нет текста (скан? приложи снимок страницы)".into());
    }
    Ok(cut(text))
}

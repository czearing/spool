use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};

pub fn validate(value: &str) -> Result<()> {
    anyhow::ensure!(value.len() <= 65_536, "Agent image must be under 64 KiB");
    let (prefix, encoded) = value.split_once(',').context("Invalid agent image")?;
    let bytes = STANDARD.decode(encoded).context("Invalid agent image encoding")?;
    let valid = match prefix {
        "data:image/png;base64" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64" => bytes.starts_with(b"\xff\xd8\xff"),
        "data:image/webp;base64" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    anyhow::ensure!(valid, "Choose a PNG, JPEG or WebP agent image");
    Ok(())
}

pub fn read(source: &str) -> Result<Option<String>> {
    let mut image = None;
    for line in super::agent::frontmatter(source)?.0.lines() {
        if let Some(("image", value)) = line.split_once(':').map(|(k, v)| (k.trim(), v)) {
            anyhow::ensure!(image.is_none(), "Duplicate agent image");
            let value = super::agent::scalar(value)?;
            validate(&value)?;
            image = Some(value);
        }
    }
    Ok(image)
}

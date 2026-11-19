//! Images 綁定（`env.IMAGES`）：讀圖片資訊、縮放、裁切、旋轉、翻轉、模糊、調亮度對比、疊圖，輸出 JPEG / PNG / WebP / GIF。
//! 用 image crate，在 rucloud 裡做，不連到外部。和 Cloudflare 的差別：WebP 只有無損壓縮（quality 不影響），
//! 不能輸出 AVIF，也不讀 AVIF / SVG（SVG 只回報格式）。
use anyhow::{bail, Context, Result};
use base64::Engine;
use image::{imageops, DynamicImage, GenericImageView, ImageFormat, ImageReader, Rgba, RgbaImage};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Cursor;

/// 解碼後的上限：寬高與記憶體（免得一張很大的圖片吃光記憶體）
const MAX_SIDE: u32 = 12_000;
const MAX_ALLOC: u64 = 512 * 1024 * 1024;

fn is_svg(data: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&data[..data.len().min(512)]).to_ascii_lowercase();
    head.trim_start().starts_with("<svg") || (head.trim_start().starts_with("<?xml") && head.contains("<svg"))
}

fn mime(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        ImageFormat::Avif => "image/avif",
        _ => "application/octet-stream",
    }
}

fn reader(data: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>> {
    let mut r = ImageReader::new(Cursor::new(data)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    r.limits(limits);
    Ok(r)
}

fn decode(data: &[u8]) -> Result<DynamicImage> {
    if is_svg(data) {
        bail!("rucloud 的 Images 不能轉換 SVG");
    }
    let r = reader(data)?;
    match r.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) => {}
        Some(f) => bail!("rucloud 的 Images 不能讀 {}", mime(f)),
        None => bail!("認不出圖片的格式"),
    }
    r.decode().context("圖片解不開")
}

/// `env.IMAGES.info(stream)`
pub fn info(data: &[u8]) -> Result<Value> {
    if is_svg(data) {
        return Ok(json!({ "format": "image/svg+xml" }));
    }
    let r = reader(data)?;
    let format = r.format().context("認不出圖片的格式")?;
    let (width, height) = r.into_dimensions().context("讀不到圖片的大小")?;
    Ok(json!({ "format": mime(format), "fileSize": data.len(), "width": width, "height": height }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Transform {
    width: Option<f64>,
    height: Option<f64>,
    fit: Option<String>,
    gravity: Option<Value>,
    background: Option<String>,
    rotate: Option<f64>,
    flip: Option<String>,
    blur: Option<f32>,
    brightness: Option<f32>,
    contrast: Option<f32>,
    /// draw() 的疊圖：PNG（base64）與位置
    overlay: Option<Overlay>,
}

#[derive(Deserialize)]
pub struct Overlay {
    image: String,
    top: Option<i64>,
    left: Option<i64>,
    bottom: Option<i64>,
    right: Option<i64>,
    opacity: Option<f32>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Output {
    format: String,
    quality: Option<u8>,
    background: Option<String>,
}

/// "#rrggbb"、"#rgb"、"rgb(r,g,b)"、"rgba(r,g,b,a)"、"transparent"、常見名稱
fn color(s: &str) -> Result<Rgba<u8>> {
    let s = s.trim().to_ascii_lowercase();
    let named = match s.as_str() {
        "transparent" => Some([0, 0, 0, 0]),
        "white" => Some([255, 255, 255, 255]),
        "black" => Some([0, 0, 0, 255]),
        "red" => Some([255, 0, 0, 255]),
        "green" => Some([0, 128, 0, 255]),
        "blue" => Some([0, 0, 255, 255]),
        "gray" | "grey" => Some([128, 128, 128, 255]),
        _ => None,
    };
    if let Some(c) = named {
        return Ok(Rgba(c));
    }
    if let Some(h) = s.strip_prefix('#') {
        let h: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.to_string() };
        if h.len() == 6 || h.len() == 8 {
            let b = hex::decode(&h).context("顏色格式不對")?;
            return Ok(Rgba([b[0], b[1], b[2], *b.get(3).unwrap_or(&255)]));
        }
    }
    if let Some(inner) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")).and_then(|r| r.strip_suffix(')')) {
        let p: Vec<f32> = inner.split(',').map(|x| x.trim().parse::<f32>()).collect::<Result<_, _>>().context("顏色格式不對")?;
        if p.len() == 3 || p.len() == 4 {
            let a = p.get(3).map(|a| (a.clamp(0.0, 1.0) * 255.0).round() as u8).unwrap_or(255);
            return Ok(Rgba([p[0] as u8, p[1] as u8, p[2] as u8, a]));
        }
    }
    bail!("認不出顏色 {s}")
}

/// gravity → 裁切時保留的位置（0..1）
fn gravity(g: &Option<Value>) -> (f64, f64) {
    match g {
        Some(Value::String(s)) => match s.as_str() {
            "left" => (0.0, 0.5),
            "right" => (1.0, 0.5),
            "top" => (0.5, 0.0),
            "bottom" => (0.5, 1.0),
            _ => (0.5, 0.5),
        },
        Some(Value::Object(o)) => (
            o.get("x").and_then(Value::as_f64).unwrap_or(0.5).clamp(0.0, 1.0),
            o.get("y").and_then(Value::as_f64).unwrap_or(0.5).clamp(0.0, 1.0),
        ),
        _ => (0.5, 0.5),
    }
}

fn side(v: Option<f64>) -> Result<Option<u32>> {
    match v {
        None => Ok(None),
        Some(x) if x >= 1.0 && x <= MAX_SIDE as f64 => Ok(Some(x.round() as u32)),
        Some(x) => bail!("寬高要在 1 到 {MAX_SIDE} 之間（{x}）"),
    }
}

fn resize(img: DynamicImage, t: &Transform) -> Result<DynamicImage> {
    let (w0, h0) = img.dimensions();
    let (tw, th) = (side(t.width)?, side(t.height)?);
    if tw.is_none() && th.is_none() {
        return Ok(img);
    }
    let fit = t.fit.as_deref().unwrap_or("scale-down");
    // 只給一邊：照比例算另一邊
    let (tw, th) = match (tw, th) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, ((h0 as f64 * w as f64 / w0 as f64).round() as u32).max(1)),
        (None, Some(h)) => (((w0 as f64 * h as f64 / h0 as f64).round() as u32).max(1), h),
        _ => unreachable!(),
    };
    let filter = imageops::FilterType::Lanczos3;
    let contain = |img: &DynamicImage, enlarge: bool| {
        let s = (tw as f64 / w0 as f64).min(th as f64 / h0 as f64);
        let s = if enlarge { s } else { s.min(1.0) };
        let (w, h) = (((w0 as f64 * s).round() as u32).max(1), ((h0 as f64 * s).round() as u32).max(1));
        if (w, h) == (w0, h0) { img.clone() } else { img.resize_exact(w, h, filter) }
    };
    Ok(match fit {
        "scale-down" => contain(&img, false),
        "contain" => contain(&img, true),
        "squeeze" => img.resize_exact(tw, th, filter),
        "cover" | "crop" => {
            if fit == "crop" && w0 <= tw && h0 <= th {
                img
            } else {
                let s = (tw as f64 / w0 as f64).max(th as f64 / h0 as f64);
                let s = if fit == "crop" { s.min(1.0) } else { s };
                let (w, h) = (((w0 as f64 * s).round() as u32).max(1), ((h0 as f64 * s).round() as u32).max(1));
                let scaled = if (w, h) == (w0, h0) { img } else { img.resize_exact(w, h, filter) };
                let (cw, ch) = (tw.min(w), th.min(h));
                let (gx, gy) = gravity(&t.gravity);
                let x = ((w - cw) as f64 * gx).round() as u32;
                let y = ((h - ch) as f64 * gy).round() as u32;
                scaled.crop_imm(x, y, cw, ch)
            }
        }
        "pad" => {
            let inner = contain(&img, true);
            let bg = color(t.background.as_deref().unwrap_or("white"))?;
            let mut canvas = RgbaImage::from_pixel(tw, th, bg);
            let x = (tw - inner.width()) as i64 / 2;
            let y = (th - inner.height()) as i64 / 2;
            imageops::overlay(&mut canvas, &inner.to_rgba8(), x, y);
            DynamicImage::ImageRgba8(canvas)
        }
        other => bail!("fit 不支援 {other}（scale-down、contain、cover、crop、pad、squeeze）"),
    })
}

fn apply(mut img: DynamicImage, t: &Transform) -> Result<DynamicImage> {
    if let Some(r) = t.rotate {
        img = match (r.rem_euclid(360.0)) as u32 {
            0 => img,
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            _ => bail!("rotate 只能是 0、90、180、270"),
        };
    }
    match t.flip.as_deref() {
        None | Some("") => {}
        Some("h") => img = img.fliph(),
        Some("v") => img = img.flipv(),
        Some("hv" | "vh") => img = img.fliph().flipv(),
        Some(f) => bail!("flip 只能是 h、v、hv（{f}）"),
    }
    img = resize(img, t)?;
    if let Some(b) = t.blur {
        if !(0.0..=250.0).contains(&b) {
            bail!("blur 要在 0 到 250 之間");
        }
        if b > 0.0 {
            img = img.blur(b / 2.0);
        }
    }
    if let Some(b) = t.brightness {
        // Cloudflare：1 不變、0.5 一半亮、2 兩倍亮
        let mut rgba = img.to_rgba8();
        for p in rgba.pixels_mut() {
            for c in &mut p.0[..3] {
                *c = (*c as f32 * b.max(0.0)).round().clamp(0.0, 255.0) as u8;
            }
        }
        img = DynamicImage::ImageRgba8(rgba);
    }
    if let Some(c) = t.contrast {
        // image 的 adjust_contrast 用百分比：1 → 0、2 → +100
        img = img.adjust_contrast((c - 1.0) * 100.0);
    }
    if let Some(o) = &t.overlay {
        let data = base64::engine::general_purpose::STANDARD.decode(&o.image).context("疊圖的資料不對")?;
        let mut top = decode(&data)?.to_rgba8();
        if let Some(a) = o.opacity {
            let a = a.clamp(0.0, 1.0);
            for p in top.pixels_mut() {
                p.0[3] = (p.0[3] as f32 * a).round() as u8;
            }
        }
        let (w, h) = img.dimensions();
        let x = match (o.left, o.right) {
            (Some(l), _) => l,
            (None, Some(r)) => w as i64 - top.width() as i64 - r,
            _ => (w as i64 - top.width() as i64) / 2,
        };
        let y = match (o.top, o.bottom) {
            (Some(t), _) => t,
            (None, Some(b)) => h as i64 - top.height() as i64 - b,
            _ => (h as i64 - top.height() as i64) / 2,
        };
        let mut base = img.to_rgba8();
        imageops::overlay(&mut base, &top, x, y);
        img = DynamicImage::ImageRgba8(base);
    }
    Ok(img)
}

/// `env.IMAGES.input(stream).transform(…).draw(…).output({ format, quality })`：回傳（內容, Content-Type）
pub fn transform(data: &[u8], steps: &[Transform], out: &Output) -> Result<(Vec<u8>, String)> {
    let mut img = decode(data)?;
    for t in steps {
        img = apply(img, t)?;
    }
    let mut buf = Vec::new();
    // 沒有透明的格式：先鋪背景色（預設白色）
    let flatten = |img: &DynamicImage| -> Result<image::RgbImage> {
        let bg = color(out.background.as_deref().unwrap_or("white"))?;
        let mut canvas = RgbaImage::from_pixel(img.width(), img.height(), Rgba([bg.0[0], bg.0[1], bg.0[2], 255]));
        imageops::overlay(&mut canvas, &img.to_rgba8(), 0, 0);
        Ok(DynamicImage::ImageRgba8(canvas).to_rgb8())
    };
    let format = out.format.as_str();
    match format {
        "image/jpeg" => {
            let q = out.quality.unwrap_or(85).clamp(1, 100);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q).encode_image(&flatten(&img)?)?;
        }
        "image/png" => img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)?,
        "image/webp" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(&mut Cursor::new(&mut buf), ImageFormat::WebP)?,
        "image/gif" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(&mut Cursor::new(&mut buf), ImageFormat::Gif)?,
        "rgb" => buf = flatten(&img)?.into_raw(),
        "rgba" => buf = img.to_rgba8().into_raw(),
        "image/avif" => bail!("rucloud 的 Images 不能輸出 AVIF，請用 image/webp、image/jpeg 或 image/png"),
        "" => bail!("output 要給 format"),
        f => bail!("output 不支援格式 {f}"),
    }
    let ct = if format.starts_with("image/") { format } else { "application/octet-stream" };
    Ok((buf, ct.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(w, h, |x, _| if x < w / 2 { Rgba([255, 0, 0, 255]) } else { Rgba([0, 0, 255, 255]) });
        let mut buf = Vec::new();
        DynamicImage::ImageRgba8(img).write_to(&mut Cursor::new(&mut buf), ImageFormat::Png).unwrap();
        buf
    }

    fn size(data: &[u8]) -> (u64, u64) {
        let i = info(data).unwrap();
        (i["width"].as_u64().unwrap(), i["height"].as_u64().unwrap())
    }

    fn t(v: Value) -> Transform {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn fits() {
        let src = png(400, 200);
        let out = |v: Value| {
            let o = Output { format: "image/png".into(), ..Default::default() };
            transform(&src, &[t(v)], &o).unwrap().0
        };
        assert_eq!(size(&out(json!({ "width": 100 }))), (100, 50));
        assert_eq!(size(&out(json!({ "width": 800, "height": 800 }))), (400, 200), "scale-down 不放大");
        assert_eq!(size(&out(json!({ "width": 800, "height": 800, "fit": "contain" }))), (800, 400));
        assert_eq!(size(&out(json!({ "width": 100, "height": 100, "fit": "cover" }))), (100, 100));
        assert_eq!(size(&out(json!({ "width": 100, "height": 100, "fit": "pad" }))), (100, 100));
        assert_eq!(size(&out(json!({ "width": 30, "height": 70, "fit": "squeeze" }))), (30, 70));
        assert_eq!(size(&out(json!({ "rotate": 90 }))), (200, 400));
        // cover + gravity left：留下左半邊的紅色
        let o = Output { format: "rgba".into(), ..Default::default() };
        let (raw, _) = transform(&src, &[t(json!({ "width": 10, "height": 10, "fit": "cover", "gravity": "left" }))], &o).unwrap();
        assert_eq!(&raw[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn formats() {
        let src = png(64, 32);
        for f in ["image/jpeg", "image/webp", "image/gif", "image/png"] {
            let (b, ct) = transform(&src, &[], &Output { format: f.into(), quality: Some(70), ..Default::default() }).unwrap();
            assert_eq!(ct, f);
            assert_eq!(info(&b).unwrap()["format"], f);
        }
        assert!(transform(&src, &[], &Output { format: "image/avif".into(), ..Default::default() }).is_err());
        assert_eq!(info(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap()["format"], "image/svg+xml");
        assert!(info(b"not an image").is_err());
        assert_eq!(color("#fff").unwrap(), Rgba([255, 255, 255, 255]));
        assert_eq!(color("rgba(0,0,0,0.5)").unwrap(), Rgba([0, 0, 0, 128]));
    }
}

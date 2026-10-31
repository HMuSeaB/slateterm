//! 验证 grid.rs 里 encode_png 的核心逻辑（不依赖 Tauri）。
use std::io::Cursor;

fn main() {
    let (w, h) = (16u32, 9u32);
    let pixels = vec![128u8; (w * h * 4) as usize];
    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(w, h, pixels).expect("from_raw failed");
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).expect("write_to failed");
    println!("PNG 编码成功: {} 字节", buf.get_ref().len());
    println!("前 8 字节: {:02X?}", &buf.get_ref()[..8]);
}

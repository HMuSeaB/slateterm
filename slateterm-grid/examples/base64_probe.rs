//! 验证 grid.rs 里手写的 base64 编解码（与 main.rs 的 decode 对称）。
const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn decode(input: &str) -> Result<Vec<u8>, String> {
    let mut rev = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() { rev[*c as usize] = i as u8; }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for b in input.bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' { continue; }
        let v = rev[b as usize];
        if v == 255 { return Err(format!("非法字符: {}", b as char)); }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    Ok(out)
}

fn main() {
    let big = vec![0xFFu8; 1000];
    let cases: Vec<&[u8]> = vec![
        b"", b"a", b"ab", b"abc", b"abcd",
        "中文测试".as_bytes(),
        b"\x1b[31mred\x1b[0m",
        &big,
    ];
    let mut ok = 0;
    for c in &cases {
        let e = encode(c);
        let d = decode(&e).expect("decode failed");
        if d.as_slice() == *c { ok += 1; } else { println!("往返失败: {:?} -> {} -> {:?}", c, e, d); }
    }
    println!("base64 往返: {}/{} 通过", ok, cases.len());
    assert!(decode("!!!").is_err(), "非法字符应报错");
    println!("非法输入校验: 通过");
}

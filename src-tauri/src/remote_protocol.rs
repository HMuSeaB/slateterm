//! SlateTerm 远程 attach 协议，主程序与 slateterm-attach 共用。
//!
//! 帧格式：`[kind: u8][len: u32 LE][payload]`。控制消息的 payload 是 JSON，
//! 输入/输出帧的 payload 是 UTF-8 文本。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::{io, path::PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

// 客户端 -> SlateTerm
pub const C2S_HELLO: u8 = 1;
pub const C2S_LIST: u8 = 2;
pub const C2S_ATTACH: u8 = 3;
pub const C2S_INPUT: u8 = 4;

// SlateTerm -> 客户端
pub const S2C_ERROR: u8 = 101;
pub const S2C_READY: u8 = 102;
pub const S2C_LIST: u8 = 103;
pub const S2C_ATTACHED: u8 = 104;
pub const S2C_OUTPUT: u8 = 105;
pub const S2C_ENDED: u8 = 106;
/// SlateTerm 窗格尺寸变了；远程窗口跟着它走，不反向改 pty 尺寸。
pub const S2C_RESIZE: u8 = 107;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub token: String,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub session_id: String,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// SlateTerm 开启远程 attach 时写到磁盘上的连接信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub pipe: String,
    pub token: String,
    pub pid: u32,
}

/// `%LOCALAPPDATA%\SlateTerm\remote.json`
pub fn connection_info_path() -> io::Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))?;
    Ok(PathBuf::from(base).join("SlateTerm").join("remote.json"))
}

pub fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
    payload: &[u8],
) -> io::Result<()> {
    writer.write_all(&encode_frame(kind, payload)).await?;
    writer.flush().await
}

pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    kind: u8,
    value: &T,
) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_frame(writer, kind, &payload).await
}

/// 读一帧；对端正常关闭时返回 `Ok(None)`。
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 5];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if is_disconnect(&error) => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "remote frame is too large"));
    }
    let mut payload = vec![0u8; len];
    match reader.read_exact(&mut payload).await {
        Ok(_) => Ok(Some((header[0], payload))),
        Err(error) if is_disconnect(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn parse_json<'a, T: Deserialize<'a>>(payload: &'a [u8]) -> io::Result<T> {
    serde_json::from_slice(payload).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn is_disconnect(error: &io::Error) -> bool {
    const ERROR_BROKEN_PIPE: i32 = 109;
    const ERROR_PIPE_NOT_CONNECTED: i32 = 233;
    matches!(error.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe)
        || matches!(error.raw_os_error(), Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED))
}

/// 与内容无关耗时的字符串比较，避免 token 被逐字节试探。
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            let frame = encode_frame(S2C_OUTPUT, "你好".as_bytes());
            let mut reader = frame.as_slice();
            let (kind, payload) = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(kind, S2C_OUTPUT);
            assert_eq!(payload, "你好".as_bytes());
            assert!(read_frame(&mut reader).await.unwrap().is_none());
        });
    }

    #[test]
    fn compares_tokens() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}

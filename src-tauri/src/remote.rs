//! 远程 attach：通过本机命名管道把 Claude 会话共享给另一个终端窗口
//! （例如 UU 远程打开的终端），对方能看到输出，也能直接打字。
//!
//! 安全边界：管道 DACL 只允许当前 Windows 用户连接，拒绝网络客户端，
//! 握手还要带一次性随机 token（写在只有本用户可读的 remote.json 里）。

use std::{
    collections::HashMap,
    ffi::c_void,
    io::Write,
    path::PathBuf,
    ptr,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncWriteExt, ReadHalf, WriteHalf},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::{broadcast, mpsc},
    task::AbortHandle,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use crate::remote_protocol::{
    connection_info_path, constant_time_eq, encode_frame, parse_json, read_frame, AttachRequest,
    Attached, ConnectionInfo, Hello, RemoteSessionInfo, C2S_ATTACH, C2S_HELLO, C2S_INPUT,
    C2S_LIST, PROTOCOL_VERSION, S2C_ATTACHED, S2C_ENDED, S2C_ERROR, S2C_LIST, S2C_OUTPUT,
    S2C_READY, S2C_RESIZE,
};

/// attach 时回放的最近输出量；Claude Code 的界面重绘一屏远小于这个值。
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type TaskList = Arc<Mutex<Vec<AbortHandle>>>;

#[derive(Clone)]
enum RemoteEvent {
    Output(Arc<str>),
    Resize(u16, u16),
    Ended,
}

struct Mirror {
    writer: PtyWriter,
    shareable: bool,
    title: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    scrollback: String,
    trimmed: bool,
    events: broadcast::Sender<RemoteEvent>,
    clients: usize,
}

struct ServerHandle {
    pipe: String,
    tasks: TaskList,
}

#[derive(Default)]
struct HubInner {
    mirrors: HashMap<String, Mirror>,
    server: Option<ServerHandle>,
}

struct Attachment {
    info: Attached,
    snapshot: String,
    events: broadcast::Receiver<RemoteEvent>,
    writer: PtyWriter,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub pipe: Option<String>,
    pub attach_command: Option<String>,
    /// 客户端 exe 是否在应用旁边；dev 构建默认不带，要先单独 cargo build
    pub client_ready: bool,
    pub client_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteClientsEvent {
    session_id: String,
    clients: usize,
}

pub struct RemoteHub {
    inner: Mutex<HubInner>,
    app: OnceLock<AppHandle>,
}

fn status_of(pipe: Option<&String>) -> RemoteStatus {
    // 首次读取状态时就把客户端准备好：同目录已有就直接用，否则从内嵌字节
    // 释放一份到 LOCALAPPDATA。这样设置面板一打开就是可用状态，不会让用户
    // 看到「找不到客户端」再去手动折腾。
    let client = ensure_attach_client().or_else(attach_client_path);
    RemoteStatus {
        enabled: pipe.is_some(),
        attach_command: pipe.map(|_| attach_command_hint(&client)),
        client_ready: client.is_some(),
        client_path: client.map(|path| path.display().to_string()),
        pipe: pipe.cloned(),
    }
}

/// 客户端 eof 的存放位置。优先应用同目录（dev 构建与老版本布局），其次
/// `%LOCALAPPDATA%\SlateTerm\slateterm-attach.exe`（内嵌释放的位置）。
fn attach_client_path() -> Option<PathBuf> {
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(ATTACH_CLIENT_FILE)))
        .filter(|path| path.is_file())
    {
        return Some(beside);
    }
    released_client_path().filter(|path| path.is_file())
}

/// 释放出来的客户端文件名带 app 版本号。否则用户升级后 `%LOCALAPPDATA%` 里
/// 还是上一版释放的旧客户端，会一直在用旧行为。带版本号则每次升级都是新路径，
/// 旧文件留在原处无害，也不需要清理逻辑。
fn released_client_path() -> Option<PathBuf> {
    let version = env!("CARGO_PKG_VERSION");
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|base| base.join("SlateTerm").join(format!("slateterm-attach-{version}.exe")))
}

const ATTACH_CLIENT_FILE: &str = "slateterm-attach.exe";

/// 内嵌的客户端字节。build.rs 编译主程序时若已在 `target/<profile>/` 找到客户端，
/// 就生成一个含 `include_bytes!` 的模块交给这里内嵌，发布版因此只需分发一个
/// exe；找不到客户端时 build.rs 生成空片段，主程序退回「应用同目录查找」的
/// 老行为，dev 与老布局都不受影响。
///
/// 用 `include!` 拉整个模块而不是在表达式里 `include_bytes!`：后者只接受字面量，
/// 喂不了编译期算出来的路径。由 build.rs 把路径写死进生成的源码，同时避开同一
/// crate 两个 bin 编译顺序不确定的问题——客户端没编出来时是空字节而非构建失败。
mod embedded_client {
    include!(concat!(env!("OUT_DIR"), "/attach_client_bytes.rs"));
}
const ATTACH_CLIENT_BYTES: &[u8] = embedded_client::ATTACH_CLIENT_BYTES;

/// 把内嵌的客户端写到 `%LOCALAPPDATA%\SlateTerm\` 并返回其路径。
///
/// 为什么不在 build.rs 里 `include_bytes!`：Cargo 不保证同一个 crate 里两个
/// bin 的编译顺序，主程序构建时客户端可能还没编出来，构建会直接失败。运行时
/// 释放没有这个依赖，代价仅是首次开启时写一个小文件。
///
/// 已存在则直接复用，不重复写；写失败只是降级为「不可用」，由调用方呈现提示，
/// 不影响 remote 的其他部分。
fn ensure_attach_client() -> Option<PathBuf> {
    // 没有内嵌字节（dev 首次构建、或客户端从未编过）时不写文件，否则会留下一个
    // 0 字节的假客户端，之后每次都被当成「已就绪」。
    if ATTACH_CLIENT_BYTES.is_empty() {
        return None;
    }
    let target = released_client_path()?;
    if target.is_file() {
        return Some(target);
    }
    let parent = target.parent()?;
    std::fs::create_dir_all(parent).ok()?;
    std::fs::write(&target, ATTACH_CLIENT_BYTES).ok()?;
    Some(target)
}

fn attach_command_hint(client: &Option<PathBuf>) -> String {
    match client {
        Some(path) => format!("& '{}'", path.display().to_string().replace('\'', "''")),
        None => "slateterm-attach".into(),
    }
}

fn lock_tasks(tasks: &TaskList) -> MutexGuard<'_, Vec<AbortHandle>> {
    tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn push_task(tasks: &TaskList, handle: AbortHandle) {
    let mut tasks = lock_tasks(tasks);
    tasks.retain(|task| !task.is_finished());
    tasks.push(handle);
}

impl RemoteHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HubInner::default()),
            app: OnceLock::new(),
        }
    }

    pub fn set_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    fn lock(&self) -> MutexGuard<'_, HubInner> {
        // 镜像只是旁路副本，锁中毒时继续用里面的数据，不能拖垮 pty 热路径
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn emit_clients(&self, session_id: &str, clients: usize) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                &format!("remote/clients/{session_id}"),
                RemoteClientsEvent {
                    session_id: session_id.to_string(),
                    clients,
                },
            );
        }
    }

    pub fn register(&self, session_id: &str, writer: PtyWriter, cols: u16, rows: u16, cwd: Option<String>) {
        let (events, _) = broadcast::channel(1024);
        self.lock().mirrors.insert(
            session_id.to_string(),
            Mirror {
                writer,
                shareable: false,
                title: None,
                cwd,
                cols,
                rows,
                scrollback: String::new(),
                trimmed: false,
                events,
                clients: 0,
            },
        );
    }

    pub fn unregister(&self, session_id: &str) {
        if let Some(mirror) = self.lock().mirrors.remove(session_id) {
            let _ = mirror.events.send(RemoteEvent::Ended);
        }
    }

    pub fn record_output(&self, session_id: &str, chunk: &str) {
        let mut inner = self.lock();
        let Some(mirror) = inner.mirrors.get_mut(session_id) else {
            return;
        };
        mirror.scrollback.push_str(chunk);
        if mirror.scrollback.len() > SCROLLBACK_LIMIT * 2 {
            let mut cut = mirror.scrollback.len() - SCROLLBACK_LIMIT;
            while !mirror.scrollback.is_char_boundary(cut) {
                cut += 1;
            }
            mirror.scrollback.drain(..cut);
            mirror.trimmed = true;
        }
        if mirror.clients > 0 {
            let _ = mirror.events.send(RemoteEvent::Output(Arc::from(chunk)));
        }
    }

    pub fn record_title(&self, session_id: &str, title: &str) {
        if let Some(mirror) = self.lock().mirrors.get_mut(session_id) {
            mirror.title = Some(title.to_string());
        }
    }

    pub fn record_cwd(&self, session_id: &str, cwd: &str) {
        if let Some(mirror) = self.lock().mirrors.get_mut(session_id) {
            mirror.cwd = Some(cwd.to_string());
        }
    }

    pub fn record_resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(mirror) = self.lock().mirrors.get_mut(session_id) {
            mirror.cols = cols;
            mirror.rows = rows;
            if mirror.clients > 0 {
                let _ = mirror.events.send(RemoteEvent::Resize(cols, rows));
            }
        }
    }

    /// 前端判定为 Claude 会话后才允许 attach；切回普通 shell 时收回。
    pub fn set_shareable(&self, session_id: &str, shareable: bool) {
        if let Some(mirror) = self.lock().mirrors.get_mut(session_id) {
            mirror.shareable = shareable;
        }
    }

    fn list(&self) -> Vec<RemoteSessionInfo> {
        self.lock()
            .mirrors
            .iter()
            .filter(|(_, mirror)| mirror.shareable)
            .map(|(id, mirror)| RemoteSessionInfo {
                id: id.clone(),
                title: mirror.title.clone(),
                cwd: mirror.cwd.clone(),
                cols: mirror.cols,
                rows: mirror.rows,
            })
            .collect()
    }

    fn attach(&self, session_id: &str) -> Result<Attachment, String> {
        let mut inner = self.lock();
        let mirror = inner
            .mirrors
            .get_mut(session_id)
            .filter(|mirror| mirror.shareable)
            .ok_or_else(|| "这个会话不存在，或者不是 Claude 会话".to_string())?;
        // 在同一把锁里取快照并订阅，回放和实时输出之间不会漏字节也不会重复
        let mut snapshot = String::new();
        if mirror.trimmed {
            // 截断点可能落在转义序列中间，先复位样式和屏幕
            snapshot.push_str("\x1b[0m\x1b[2J\x1b[H");
        }
        snapshot.push_str(&mirror.scrollback);
        mirror.clients += 1;
        let clients = mirror.clients;
        let attachment = Attachment {
            info: Attached {
                session_id: session_id.to_string(),
                title: mirror.title.clone(),
                cols: mirror.cols,
                rows: mirror.rows,
            },
            snapshot,
            events: mirror.events.subscribe(),
            writer: Arc::clone(&mirror.writer),
        };
        drop(inner);
        self.emit_clients(session_id, clients);
        Ok(attachment)
    }

    fn detach(&self, session_id: &str) {
        let clients = {
            let mut inner = self.lock();
            let Some(mirror) = inner.mirrors.get_mut(session_id) else {
                return;
            };
            mirror.clients = mirror.clients.saturating_sub(1);
            mirror.clients
        };
        self.emit_clients(session_id, clients);
    }

    pub fn status(&self) -> RemoteStatus {
        status_of(self.lock().server.as_ref().map(|server| &server.pipe))
    }

    pub fn enable(self: &Arc<Self>) -> Result<RemoteStatus, String> {
        // 整个开启过程持有 hub 锁，两次并发开启不会各建一套管道
        let mut inner = self.lock();
        if let Some(server) = &inner.server {
            return Ok(status_of(Some(&server.pipe)));
        }

        let user_sid = current_user_sid()?;
        let pipe = format!(r"\\.\pipe\slateterm-remote-{}", Uuid::new_v4().simple());
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let security = PipeSecurity::for_user(&user_sid)?;

        // 第一个实例必须在这里同步建好：first_pipe_instance 能防止别的进程
        // 抢先占用同名管道，失败也能直接报给前端
        let first = security.create(&pipe, true).map_err(|error| format!("无法创建远程管道：{error}"))?;
        write_connection_info(&ConnectionInfo {
            pipe: pipe.clone(),
            token: token.clone(),
            pid: std::process::id(),
        })?;

        let tasks: TaskList = Arc::new(Mutex::new(Vec::new()));
        let hub = Arc::clone(self);
        let accept_tasks = Arc::clone(&tasks);
        let accept_pipe = pipe.clone();
        let accept = tauri::async_runtime::spawn(async move {
            hub.accept_loop(first, security, accept_pipe, token, accept_tasks).await;
        });
        push_task(&tasks, accept.inner().abort_handle());

        let status = status_of(Some(&pipe));
        inner.server = Some(ServerHandle { pipe, tasks });
        Ok(status)
    }

    pub fn disable(&self) -> RemoteStatus {
        // 先把 server 取出来再处理，不在持有 hub 锁的时候去中断任务
        let server = self.lock().server.take();
        if let Some(server) = server {
            // 中断 accept 循环和所有已连接的客户端；管道句柄随任务一起释放
            for task in lock_tasks(&server.tasks).drain(..) {
                task.abort();
            }
        }
        remove_connection_info();
        let session_ids: Vec<String> = {
            let mut inner = self.lock();
            inner
                .mirrors
                .iter_mut()
                .filter(|(_, mirror)| mirror.clients > 0)
                .map(|(id, mirror)| {
                    mirror.clients = 0;
                    id.clone()
                })
                .collect()
        };
        for session_id in session_ids {
            self.emit_clients(&session_id, 0);
        }
        self.status()
    }

    async fn accept_loop(
        self: Arc<Self>,
        first: NamedPipeServer,
        security: PipeSecurity,
        pipe: String,
        token: String,
        tasks: TaskList,
    ) {
        let mut server = first;
        loop {
            let result = server.connect().await;
            // 每个客户端用独立的管道实例：先建好下一个实例再交出当前这个，
            // 中间不会出现"管道不存在"的空窗
            let next = loop {
                match security.create(&pipe, false) {
                    Ok(next) => break next,
                    Err(error) => {
                        eprintln!("SlateTerm remote: could not create pipe instance ({error})");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            };
            let connected = std::mem::replace(&mut server, next);
            match result {
                Ok(()) => {
                    let hub = Arc::clone(&self);
                    let token = token.clone();
                    let client = tauri::async_runtime::spawn(async move {
                        hub.serve_client(connected, token).await;
                    });
                    push_task(&tasks, client.inner().abort_handle());
                }
                Err(error) => {
                    eprintln!("SlateTerm remote: pipe connect failed ({error})");
                    drop(connected);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }

    async fn serve_client(self: Arc<Self>, pipe: NamedPipeServer, token: String) {
        let (mut reader, mut writer) = tokio::io::split(pipe);

        let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut reader)).await {
            Ok(Ok(Some((C2S_HELLO, payload)))) => parse_json::<Hello>(&payload).ok(),
            _ => None,
        };
        let Some(hello) = hello else {
            return;
        };
        if !constant_time_eq(&hello.token, &token) {
            let _ = send_error(&mut writer, "token 不对，请重新运行 slateterm-attach").await;
            return;
        }
        if hello.version != PROTOCOL_VERSION {
            let _ = send_error(&mut writer, "slateterm-attach 与 SlateTerm 版本不一致").await;
            return;
        }
        if send_json(&mut writer, S2C_READY, &serde_json::json!({ "version": PROTOCOL_VERSION }))
            .await
            .is_err()
        {
            return;
        }

        // 握手后先处理列表请求，直到客户端选定一个会话
        let attachment = loop {
            let Ok(Some((kind, payload))) = read_frame(&mut reader).await else {
                return;
            };
            match kind {
                C2S_LIST => {
                    if send_json(&mut writer, S2C_LIST, &self.list()).await.is_err() {
                        return;
                    }
                }
                C2S_ATTACH => {
                    let Ok(request) = parse_json::<AttachRequest>(&payload) else {
                        return;
                    };
                    match self.attach(&request.session_id) {
                        Ok(attachment) => break attachment,
                        Err(message) => {
                            if send_error(&mut writer, &message).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                _ => return,
            }
        };

        self.run_attached(attachment, reader, writer).await;
    }

    async fn run_attached(
        self: Arc<Self>,
        attachment: Attachment,
        mut reader: ReadHalf<NamedPipeServer>,
        writer: WriteHalf<NamedPipeServer>,
    ) {
        let Attachment {
            info,
            snapshot,
            events,
            writer: pty_writer,
        } = attachment;
        // 不论以哪种方式退出（包括关闭远程功能时整个任务被 abort），都要扣掉连接数
        let _detach = DetachGuard {
            hub: Arc::clone(&self),
            session_id: info.session_id.clone(),
        };
        let forward = AbortOnDrop(tokio::spawn(forward_output(writer, info, snapshot, events)));

        // pty 写入是阻塞调用，放到专用线程里按顺序执行
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let input_writer = tokio::task::spawn_blocking(move || {
            while let Some(data) = input_rx.blocking_recv() {
                let Ok(mut writer) = pty_writer.lock() else {
                    break;
                };
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });

        while let Ok(Some((kind, payload))) = read_frame(&mut reader).await {
            if forward.0.is_finished() {
                break;
            }
            if kind == C2S_INPUT && !payload.is_empty() && input_tx.send(payload).is_err() {
                break;
            }
        }

        drop(input_tx);
        drop(forward);
        let _ = input_writer.await;
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct DetachGuard {
    hub: Arc<RemoteHub>,
    session_id: String,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        self.hub.detach(&self.session_id);
    }
}

async fn forward_output(
    mut writer: WriteHalf<NamedPipeServer>,
    info: Attached,
    snapshot: String,
    mut events: broadcast::Receiver<RemoteEvent>,
) {
    if send_json(&mut writer, S2C_ATTACHED, &info).await.is_err() {
        return;
    }
    for chunk in utf8_chunks(&snapshot, 64 * 1024) {
        if send_raw(&mut writer, S2C_OUTPUT, chunk.as_bytes()).await.is_err() {
            return;
        }
    }
    loop {
        let frame = match events.recv().await {
            Ok(RemoteEvent::Output(chunk)) => encode_frame(S2C_OUTPUT, chunk.as_bytes()),
            Ok(RemoteEvent::Resize(cols, rows)) => {
                let payload = serde_json::json!({ "cols": cols, "rows": rows }).to_string();
                encode_frame(S2C_RESIZE, payload.as_bytes())
            }
            Ok(RemoteEvent::Ended) | Err(broadcast::error::RecvError::Closed) => {
                let _ = send_raw(&mut writer, S2C_ENDED, b"").await;
                return;
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // 远程端跟不上，丢了一段输出；提示一下，Claude 下次重绘会自愈
                encode_frame(S2C_OUTPUT, "\r\n\x1b[33m[slateterm] 网络较慢，跳过了一段输出\x1b[0m\r\n".as_bytes())
            }
        };
        if writer.write_all(&frame).await.is_err() || writer.flush().await.is_err() {
            return;
        }
    }
}

fn utf8_chunks(text: &str, max_bytes: usize) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(max_bytes);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, tail) = rest.split_at(end);
        chunks.push(chunk);
        rest = tail;
    }
    chunks
}

async fn send_raw(writer: &mut WriteHalf<NamedPipeServer>, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    writer.write_all(&encode_frame(kind, payload)).await?;
    writer.flush().await
}

async fn send_json<T: Serialize>(writer: &mut WriteHalf<NamedPipeServer>, kind: u8, value: &T) -> std::io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    send_raw(writer, kind, &payload).await
}

async fn send_error(writer: &mut WriteHalf<NamedPipeServer>, message: &str) -> std::io::Result<()> {
    send_json(writer, S2C_ERROR, &serde_json::json!({ "message": message })).await
}

/// 管道的安全描述符：只有当前用户能读写，网络登录一律拒绝。
struct PipeSecurity {
    descriptor: *mut c_void,
}

// 描述符创建后只读，跨线程共享安全
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    fn for_user(user_sid: &str) -> Result<Self, String> {
        // D:P 阻止继承默认 ACL；NU = 网络登录用户
        let sddl = wide_null(&format!("O:{user_sid}D:P(D;;GA;;;NU)(A;;GA;;;{user_sid})"));
        let mut descriptor: *mut c_void = ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(format!("无法生成管道权限：{}", std::io::Error::last_os_error()));
        }
        Ok(Self { descriptor })
    }

    fn create(&self, pipe: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        };
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(pipe, &mut attributes as *mut _ as *mut c_void)
        }
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn current_user_sid() -> Result<String, String> {
    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!("无法读取当前用户：{}", std::io::Error::last_os_error()));
        }
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        // u64 缓冲保证 TOKEN_USER 的指针字段对齐
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            (buffer.len() * 8) as u32,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(format!("无法读取当前用户：{}", std::io::Error::last_os_error()));
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut sid_string: *mut u16 = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_string) == 0 || sid_string.is_null() {
            return Err(format!("无法读取当前用户 SID：{}", std::io::Error::last_os_error()));
        }
        let mut length = 0usize;
        while *sid_string.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, length));
        LocalFree(sid_string as *mut c_void);
        Ok(sid)
    }
}

fn write_connection_info(info: &ConnectionInfo) -> Result<(), String> {
    let path = connection_info_path().map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // %LOCALAPPDATA% 默认只有本用户和管理员可读，token 不会暴露给其他用户
    let raw = serde_json::to_string_pretty(info).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| format!("无法写入 {}：{error}", path.display()))
}

fn remove_connection_info() {
    if let Ok(path) = connection_info_path() {
        let _ = std::fs::remove_file(path);
    }
}

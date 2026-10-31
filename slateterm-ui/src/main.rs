//! 最小自绘窗口：验证"我们自己的组件跑在 GPUI 上"这件事成立。
//!
//! 全部手写 div，不碰 gpui-kit 的现成组件，
//! 目的是确认现有的拟物风格（分层表面 + 高光描边 + 强调色）能原样搬到 GPUI 的绘制模型里。
//!
//! `cargo run -- --shot out.png` 走离屏渲染，不开窗口，用来出设计稿对比图。

use gpui::prelude::*;
use gpui::*;

use slateterm_ui::{Mode, Theme, metrics, radius};

struct Shell {
    theme: Theme,
}

impl Shell {
    fn new(mode: Mode) -> Self {
        Self { theme: Theme::new(mode) }
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.theme.palette.clone();
        if std::env::var("SLATE_DEBUG_LAYOUT").is_ok() {
            eprintln!(
                "viewport = {:?}  bounds = {:?}",
                window.viewport_size(),
                window.bounds()
            );
        }

        // 浮起的卡片与压下的凹槽，靠 token 区分，不靠透明黑堆叠。
        let card = |color: Rgba, lift: bool| {
            let el = div()
                .rounded(px(radius::MD))
                .bg(color)
                .border_1()
                .border_color(if lift { p.edge_light } else { p.edge_dark });
            if lift { el } else { el }
        };

        let row = |label: String, active: bool, p: &slateterm_ui::Palette| {
            div()
                .flex()
                .items_center()
                .h(px(metrics::height::MD))
                .px_2()
                .rounded(px(radius::SM))
                .when(active, |el| el.bg(p.accent_soft))
                .text_color(if active { p.text } else { p.text_muted })
                .text_size(px(metrics::font::BODY))
                .child(label)
        };

        let mono = |text: &str, color: Rgba, p: &slateterm_ui::Palette| {
            div()
                .text_color(color)
                .font_family(if p.text.r > 0.5 { "Cascadia Mono" } else { "Cascadia Mono" })
                .text_size(px(metrics::font::BODY))
                .child(text.to_string())
        };

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(p.base)
            .text_color(p.text)
            .text_size(px(metrics::font::BODY))
            .child(
                // 标题栏：58px，与现有 SlateTerm 一致
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .h(px(metrics::height::TITLEBAR))
                    .px(px(16.0))
                    .border_b_1()
                    .border_color(p.edge_light)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(div().size(px(9.0)).rounded_full().bg(p.accent))
                            .child(
                                div()
                                    .text_size(px(metrics::font::TITLE))
                                    .child("SlateTerm"),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(metrics::font::SMALL))
                            .text_color(p.text_muted)
                            .child("GPUI · self-drawn"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h(px(0.0))
                    .gap(px(12.0))
                    .p(px(12.0))
                    .child(
                        card(p.soft, false)
                            .flex()
                            .flex_col()
                            .flex_none()
                            .w(px(metrics::height::SIDEBAR))
                            .min_w(px(160.0))
                            .p(px(8.0))
                            .gap(px(4.0))
                            .child(
                                div()
                                    .text_size(px(metrics::font::SMALL))
                                    .text_color(p.text_muted)
                                    .px(px(8.0))
                                    .py(px(4.0))
                                    .child("Sessions"),
                            )
                            .child(row("PowerShell".into(), true, &p))
                            .child(row("wsl · Ubuntu".into(), false, &p))
                            .child(row("pwsh · admin".into(), false, &p)),
                    )
                    .child(
                        card(p.inset, false)
                            .flex()
                            .flex_col()
                            .flex_1()
                            .flex_basis(px(0.0))
                            .min_w(px(0.0))
                            .p(px(16.0))
                            .gap(px(4.0))
                            .child(mono("PS D:\\4rchive\\Code\\SlateTerm>", p.term_fg, &p))
                            .child(mono("cargo run --release", p.accent, &p))
                            .child(mono("self-drawn grid comes next", p.text_muted, &p))
                            .child(mono("", p.term_fg, &p))
                            .child(mono("PS D:\\4rchive\\Code\\SlateTerm>", p.term_fg, &p)),
                    )
                    .child(
                        card(p.raised, true)
                            .flex()
                            .flex_col()
                            .flex_none()
                            .w(px(220.0))
                            .p(px(12.0))
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(metrics::font::SMALL))
                                    .text_color(p.text_muted)
                                    .child("Files"),
                            )
                            .child(div().text_size(px(metrics::font::BODY)).child("src"))
                            .child(div().text_size(px(metrics::font::BODY)).child("src-tauri"))
                            .child(div().text_size(px(metrics::font::BODY)).child("docs")),
                    ),
            )
            .into_any_element()
    }
}

/// 屏幕 DPI 缩放因子。
///
/// gpui-pre 0.3.10 的 Windows 后端不声明 DPI 感知，
/// 系统按缩放比例拉伸一次，视图却仍按逻辑像素布局，结果右侧内容被裁。
/// 在框架修好之前，只能用"物理像素 = 逻辑像素 × 缩放"的方式凑窗口尺寸。
#[cfg(windows)]
fn scale_factor() -> f32 {
    const LOGPIXELSX: i32 = 88;
    unsafe {
        let hdc = windows_sys::Win32::Graphics::Gdi::GetDC(std::ptr::null_mut());
        if hdc.is_null() {
            return 1.0;
        }
        let dpi = windows_sys::Win32::Graphics::Gdi::GetDeviceCaps(hdc, LOGPIXELSX);
        windows_sys::Win32::Graphics::Gdi::ReleaseDC(std::ptr::null_mut(), hdc);
        if dpi > 0 { dpi as f32 / 96.0 } else { 1.0 }
    }
}

#[cfg(not(windows))]
fn scale_factor() -> f32 {
    1.0
}

fn window_options() -> WindowOptions {
    // gpui-pre 0.3.10 的 Windows 后端把屏幕物理像素当逻辑像素用，
    // 且 swap chain 初始为 1×1、只靠 WM_SIZE 扩张，创建时即为最终尺寸就可能拿不到这个事件。
    // 因此按"真实可绘制区域"开窗，并在启动后主动 set 一次窗口尺寸，逼出 resize。
    let s = scale_factor();
    let w = 1080.0 * s;
    let h = 680.0 * s;
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(0.0), px(0.0)),
            size(px(w), px(h)),
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some("SlateTerm · GPUI probe".into()),
            appears_transparent: true,
            traffic_light_position: None,
        }),
        ..Default::default()
    }
}

/// 声明 Per-Monitor V2 DPI 感知。
///
/// gpui-pre 0.3.10 的 Windows 后端不调用 `SetProcessDpiAwareness`，
/// 进程默认是 DPI-unaware，系统会再按缩放比例拉伸一次，结果窗口内容被裁掉。
/// 在 GPUI 启动前补这一步即可；这是应用侧能做的正确修法。
#[cfg(windows)]
fn make_dpi_aware() {
    // -4 == DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    const PER_MONITOR_V2: isize = -4;
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            PER_MONITOR_V2 as *mut core::ffi::c_void,
        );
    }
}

#[cfg(not(windows))]
fn make_dpi_aware() {}

fn main() {
    make_dpi_aware();
    // --shot <path> [light|dark]：离屏渲染一张 PNG，不开窗口。
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--shot") {
        eprintln!(
            "--shot 在当前模型下不可用：gpui-pre 的 Windows 后端未实现 render_to_image。\
             请用 shots/capture.ps1 抓取真实窗口。"
        );
        let _ = args.get(pos + 1);
        return;
    }

    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        let (handle, _view) =
            gpui_kit::open_window(window_options(), cx, |_, cx| cx.new(|_| Shell::new(Mode::Dark)))
                .expect("failed to open window");
        // 先缩一次再放回，确保 SWAP CHAIN 收到 WM_SIZE 并被 resize。
        if let Some(w) = handle.downcast::<gpui_kit::base::Root>() {
            let _ = w.update(cx, |_, window, _| {
                let s = scale_factor();
                window.resize(size(px(1079.0 * s), px(679.0 * s)));
            });
            cx.defer(move |cx| {
                if let Some(w) = handle.downcast::<gpui_kit::base::Root>() {
                    let _ = w.update(cx, |_, window, _| {
                        let s = scale_factor();
                        window.resize(size(px(1080.0 * s), px(680.0 * s)));
                    });
                }
            });
        }
    });
}

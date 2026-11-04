mod app;

use std::path::Path;

#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::WindowEvent;

use app::wheel::Source;

pub fn run() {
    // Sous Wayland, GNOME ne laisse ni placer une fenêtre ni la garder au premier plan :
    // la roue passe par XWayland, qui le permet
    #[cfg(target_os = "linux")]
    if platform::session::is_wayland_session() && std::env::var_os("GDK_BACKEND").is_none() {
        // SAFETY : appelé avant toute création de thread
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    // Avec le pilote NVIDIA, le rendu DMA-BUF de WebKitGTK peut laisser la fenêtre vide
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/proc/driver/nvidia/version").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        // SAFETY : appelé avant toute création de thread
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    let builder = tauri::Builder::default()
        // En premier : relancer Rutile (avec ou sans fichiers) ouvre la roue de l'instance en cours
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let source = app::launch::request(&args, Path::new(&cwd)).unwrap_or(Source::Selection);
            app::wheel::open(app, source);
        }))
        .plugin(app::shortcut::plugin())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .manage(app::wheel::WheelState::default())
        .invoke_handler(tauri::generate_handler![
            app::wheel::wheel_ready,
            app::wheel::hide_wheel,
            app::wheel::primary_button_pressed,
            app::wheel::pick_files,
            app::convert::inspect_files,
            app::convert::convert_files,
            app::convert::convert_videos,
            app::convert::video_support,
            app::settings::get_settings,
            app::settings::update_settings,
            app::settings::set_launch_at_login,
            app::settings::open_permission_settings,
            app::apps::wheel_config,
            app::apps::pick_app,
            app::apps::launch_app,
            app::apps::open_settings,
            app::share::share_choices,
            app::share::pick_share_folder,
            app::share::share_files,
        ])
        .setup(|app| {
            // Pas d'icône dans le Dock (LSUIElement fait de même pour l'app installée)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings = app::settings::load(app.handle());
            app::notify::setup(app.handle())?;
            app::wheel::setup(app.handle())?;
            app::tray::setup(app.handle(), &settings.shortcut)?;
            app::shortcut::register(app.handle(), &settings.shortcut);
            app::permissions::check_at_startup(app.handle());
            if let Err(err) = app::shake::apply(app.handle(), settings.shake()) {
                app::notify::show(
                    app.handle(),
                    app::notify::Message {
                        title: "Secouage indisponible".into(),
                        body: err,
                        action: None,
                    },
                );
            }

            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            if let Some(source) = app::launch::request(&args, &cwd) {
                app::wheel::open(app.handle(), source);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // La roue pré-chargée ne doit jamais être détruite, seulement masquée
            WindowEvent::CloseRequested { api, .. }
                if window.label() == app::wheel::WHEEL_LABEL =>
            {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::DragDrop(drag) if window.label() == app::wheel::WHEEL_LABEL => {
                app::wheel::forward_drag(window, drag);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Rutile")
        .run(|_handle, _event| {
            // Rouvrir l'app depuis le Finder ou Spotlight alors qu'elle tourne déjà
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = _event {
                app::wheel::open(_handle, Source::Selection);
            }
        });
}

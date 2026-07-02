#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerialConfig {
    port: String,
    baudrate: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannerStatusEvent {
    connected: bool,
    mode: String,
    port: Option<String>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannerScanEvent {
    code: String,
    source: String,
}

struct SerialWorker {
    stop: Arc<AtomicBool>,
    join_handle: thread::JoinHandle<()>,
    port: String,
}

#[derive(Default)]
struct ScannerState {
    worker: Mutex<Option<SerialWorker>>,
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn connect_serial_scanner(
    app: AppHandle,
    state: State<ScannerState>,
    config: SerialConfig,
) -> Result<(), String> {
    disconnect_worker(None, &state)?;

    let port_name = config.port.clone();
    let baudrate = config.baudrate;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let app_handle = app.clone();
    let port_name_for_thread = port_name.clone();

    let join_handle = thread::spawn(move || {
        let serial_result = serialport::new(&port_name_for_thread, baudrate)
            .timeout(Duration::from_millis(200))
            .open();

        match serial_result {
            Ok(mut connection) => {
                let _ = app_handle.emit(
                    "scanner://status",
                    ScannerStatusEvent {
                        connected: true,
                        mode: "serial".into(),
                        port: Some(port_name_for_thread.clone()),
                        message: format!(
                            "Lector serial conectado en {} a {} baudios.",
                            port_name_for_thread, baudrate
                        ),
                    },
                );

                let mut byte_buffer = [0u8; 256];
                let mut text_buffer = String::new();

                while !stop_for_thread.load(Ordering::Relaxed) {
                    match connection.read(&mut byte_buffer) {
                        Ok(count) if count > 0 => {
                            let chunk = String::from_utf8_lossy(&byte_buffer[..count]);
                            for character in chunk.chars() {
                                if matches!(character, '\n' | '\r' | '\t') {
                                    let code = text_buffer.trim().to_string();
                                    if code.len() >= 6 {
                                        let _ = app_handle.emit(
                                            "scanner://scan",
                                            ScannerScanEvent {
                                                code,
                                                source: "serial".into(),
                                            },
                                        );
                                    }
                                    text_buffer.clear();
                                } else if character.is_ascii_graphic() {
                                    text_buffer.push(character);
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(error) => {
                            let _ = app_handle.emit(
                                "scanner://status",
                                ScannerStatusEvent {
                                    connected: false,
                                    mode: "serial".into(),
                                    port: Some(port_name_for_thread.clone()),
                                    message: format!("Error de lectura serial: {}", error),
                                },
                            );
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                let _ = app_handle.emit(
                    "scanner://status",
                    ScannerStatusEvent {
                        connected: false,
                        mode: "serial".into(),
                        port: Some(port_name_for_thread.clone()),
                        message: format!("No se pudo abrir el lector serial: {}", error),
                    },
                );
            }
        }

        let _ = app_handle.emit(
            "scanner://status",
            ScannerStatusEvent {
                connected: false,
                mode: "serial".into(),
                port: Some(port_name_for_thread),
                message: "Lector serial desconectado.".into(),
            },
        );
    });

    let mut worker_slot = state.worker.lock().map_err(|error| error.to_string())?;
    *worker_slot = Some(SerialWorker {
        stop,
        join_handle,
        port: port_name,
    });

    Ok(())
}

#[tauri::command]
fn disconnect_serial_scanner(state: State<ScannerState>) -> Result<(), String> {
    disconnect_worker(None, &state)
}

fn disconnect_worker(
    app: Option<&AppHandle>,
    state: &State<ScannerState>,
) -> Result<(), String> {
    let worker = {
        let mut slot = state.worker.lock().map_err(|error| error.to_string())?;
        slot.take()
    };

    if let Some(worker) = worker {
        worker.stop.store(true, Ordering::Relaxed);
        let port_name = worker.port.clone();
        let _ = worker.join_handle.join();

        if let Some(app_handle) = app {
            let _ = app_handle.emit(
                "scanner://status",
                ScannerStatusEvent {
                    connected: false,
                    mode: "serial".into(),
                    port: Some(port_name),
                    message: "Lector serial desconectado.".into(),
                },
            );
        }
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(ScannerState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_serial_scanner,
            disconnect_serial_scanner
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: State<ScannerState> = window.state();
                let _ = disconnect_worker(None, &state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

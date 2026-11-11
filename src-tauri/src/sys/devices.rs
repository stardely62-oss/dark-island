//! Sound devices and Bluetooth on Windows: which output and microphone the
//! island works with, a player's own volume, paired Bluetooth devices with
//! their charge, and connecting headphones and speakers in one press.

use serde::Serialize;
use windows::core::{Interface, GUID, HSTRING};
use windows::Devices::Bluetooth::{BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationKind};
use windows_collections::IIterable;
use windows::Foundation::IReference;
use windows::Win32::Devices::FunctionDiscovery::{PKEY_Device_ContainerId, PKEY_Device_FriendlyName};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IAudioSessionControl2, IAudioSessionManager2, IConnector, IDeviceTopology,
    IMMDevice, IMMDeviceEnumerator, IPart, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
};
use windows::Win32::Media::KernelStreaming::{IKsControl, KSIDENTIFIER, KSIDENTIFIER_0, KSIDENTIFIER_0_0};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
use windows::Win32::System::Com::StructuredStorage::{PropVariantToGUID, PropVariantToStringAlloc};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

fn enumerator() -> Option<IMMDeviceEnumerator> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()
    }
}

unsafe fn device_id(d: &IMMDevice) -> String {
    d.GetId()
        .map(|p| {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        })
        .unwrap_or_default()
}

unsafe fn prop_string(store: &IPropertyStore, key: &PROPERTYKEY) -> String {
    let Ok(v) = store.GetValue(key) else { return String::new() };
    match PropVariantToStringAlloc(&v) {
        Ok(p) => {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
        Err(_) => String::new(),
    }
}

unsafe fn container_of(d: &IMMDevice) -> Option<GUID> {
    let store = d.OpenPropertyStore(STGM_READ).ok()?;
    let v = store.GetValue(&PKEY_Device_ContainerId).ok()?;
    PropVariantToGUID(&v).ok()
}

// ------------------------------------------------------------- sound devices ----

#[derive(Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub default: bool,
}

#[derive(Serialize)]
pub struct AudioDevices {
    pub outputs: Vec<AudioDevice>,
    pub inputs: Vec<AudioDevice>,
}

fn list(flow: EDataFlow) -> Vec<AudioDevice> {
    let Some(e) = enumerator() else { return Vec::new() };
    unsafe {
        let default = e.GetDefaultAudioEndpoint(flow, eConsole).map(|d| device_id(&d)).unwrap_or_default();
        let Ok(col) = e.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { return Vec::new() };
        (0..col.GetCount().unwrap_or(0))
            .filter_map(|i| col.Item(i).ok())
            .map(|d| {
                let id = device_id(&d);
                let name = d.OpenPropertyStore(STGM_READ).map(|s| prop_string(&s, &PKEY_Device_FriendlyName)).unwrap_or_default();
                AudioDevice { default: id == default, id, name }
            })
            .collect()
    }
}

pub fn audio_devices() -> AudioDevices {
    AudioDevices { outputs: list(eRender), inputs: list(eCapture) }
}

/// A device by its id, or the default one for `flow` when `id` is empty.
pub fn device(flow: EDataFlow, id: &str) -> Option<IMMDevice> {
    let e = enumerator()?;
    unsafe {
        if !id.is_empty() {
            if let Ok(d) = e.GetDevice(&HSTRING::from(id)) {
                return Some(d);
            }
        }
        e.GetDefaultAudioEndpoint(flow, eConsole).ok()
    }
}

// ------------------------------------------------------------ player volume ----

/// Volume controls of the audio sessions that belong to a player (matched
/// by the media session's app id against the process names).
fn player_sessions(app: &str, output: &str) -> Vec<ISimpleAudioVolume> {
    let app = app.to_lowercase();
    let Some(dev) = device(eRender, output) else { return Vec::new() };
    let mut out = Vec::new();
    unsafe {
        let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return out };
        let Ok(en) = mgr.GetSessionEnumerator() else { return out };
        for i in 0..en.GetCount().unwrap_or(0) {
            let Ok(ctl) = en.GetSession(i) else { continue };
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = ctl2.GetProcessId() else { continue };
            if pid == 0 {
                continue;
            }
            let exe = super::windows::process_path(pid).to_lowercase();
            let stem = exe.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_string();
            if stem.is_empty() {
                continue;
            }
            // "Spotify.exe", "chrome", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"…
            let hit = app.contains(&stem) || (stem.len() > 3 && app.split(['.', '!', '_']).any(|p| p == stem))
                || (stem == "msedge" && app.contains("edge"))
                || (stem == "zune" && app.contains("zune"));
            if hit {
                if let Ok(v) = ctl.cast::<ISimpleAudioVolume>() {
                    out.push(v);
                }
            }
        }
    }
    out
}

pub fn player_volume(app: &str, output: &str) -> Option<f32> {
    let s = player_sessions(app, output);
    unsafe { s.first()?.GetMasterVolume().ok() }
}

pub fn set_player_volume(app: &str, output: &str, level: f32) -> bool {
    let s = player_sessions(app, output);
    let mut ok = false;
    for v in &s {
        ok |= unsafe { v.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null()) }.is_ok();
    }
    ok
}

// ---------------------------------------------------------------- bluetooth ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub battery: Option<u8>,
    /// Headphones or speakers: can be connected from the island.
    pub audio: bool,
    pub container: String,
}

const BATTERY: &str = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";

fn props(list: &[&str]) -> IIterable<HSTRING> {
    list.iter().map(|s| HSTRING::from(*s)).collect::<Vec<_>>().into()
}

fn lookup_bool(info: &DeviceInformation, key: &str) -> Option<bool> {
    let v = info.Properties().ok()?.Lookup(&HSTRING::from(key)).ok()?;
    v.cast::<IReference<bool>>().ok()?.Value().ok()
}

fn lookup_guid(info: &DeviceInformation, key: &str) -> Option<GUID> {
    let v = info.Properties().ok()?.Lookup(&HSTRING::from(key)).ok()?;
    v.cast::<IReference<GUID>>().ok()?.Value().ok()
}

/// Audio endpoints (outputs and microphones, in any state) that belong to a
/// Bluetooth device, matched by container id.
fn endpoints_of(container: &GUID) -> Vec<(IMMDevice, bool)> {
    let Some(e) = enumerator() else { return Vec::new() };
    let mut out = Vec::new();
    unsafe {
        for flow in [eRender, eCapture] {
            let Ok(col) = e.EnumAudioEndpoints(flow, DEVICE_STATE(0x0F)) else { continue };
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(d) = col.Item(i) else { continue };
                if container_of(&d).as_ref() == Some(container) {
                    let active = d.GetState().map(|s| s == DEVICE_STATE_ACTIVE).unwrap_or(false);
                    out.push((d, active));
                }
            }
        }
    }
    out
}

pub fn bt_devices() -> Vec<BtDevice> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let wanted = props(&["System.Devices.Aep.IsConnected", "System.Devices.Aep.ContainerId"]);
    let mut infos: Vec<DeviceInformation> = Vec::new();
    for sel in [BluetoothDevice::GetDeviceSelectorFromPairingState(true), BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)]
        .into_iter()
        .flatten()
    {
        if let Ok(col) = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(&sel, &wanted).and_then(|op| op.join()) {
            infos.extend(col);
        }
    }
    // Battery charge sits on the device's driver nodes, joined by container id.
    let mut charge: Vec<(GUID, u8)> = Vec::new();
    let battery_props = props(&[BATTERY, "System.Devices.ContainerId"]);
    if let Ok(col) = DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
        &HSTRING::from(""),
        &battery_props,
        DeviceInformationKind::Device,
    )
    .and_then(|op| op.join())
    {
        for d in col {
            let Ok(p) = d.Properties() else { continue };
            let level = p.Lookup(&HSTRING::from(BATTERY)).ok().and_then(|v| v.cast::<IReference<u8>>().ok()).and_then(|r| r.Value().ok());
            let cont = p
                .Lookup(&HSTRING::from("System.Devices.ContainerId"))
                .ok()
                .and_then(|v| v.cast::<IReference<GUID>>().ok())
                .and_then(|r| r.Value().ok());
            if let (Some(l), Some(c)) = (level, cont) {
                charge.push((c, l));
            }
        }
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for info in infos {
        let name = info.Name().map(|h| h.to_string_lossy()).unwrap_or_default();
        let container = lookup_guid(&info, "System.Devices.Aep.ContainerId");
        let key = container.map(|g| format!("{g:?}")).unwrap_or_else(|| name.clone());
        if name.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());
        let eps = container.map(|c| endpoints_of(&c)).unwrap_or_default();
        let audio = !eps.is_empty();
        let connected = lookup_bool(&info, "System.Devices.Aep.IsConnected").unwrap_or(false)
            || eps.iter().any(|(_, active)| *active);
        out.push(BtDevice {
            id: info.Id().map(|h| h.to_string_lossy()).unwrap_or_default(),
            name,
            connected,
            battery: container.and_then(|c| charge.iter().find(|(g, _)| *g == c).map(|(_, l)| *l)),
            audio,
            container: key,
        });
    }
    out.sort_by(|a, b| b.connected.cmp(&a.connected).then(a.name.cmp(&b.name)));
    out
}

/// Connects or disconnects Bluetooth headphones or speakers, by asking the
/// Bluetooth audio driver of their endpoints to reconnect or disconnect.
pub fn bt_connect(container: &str, on: bool) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let guid = parse_guid(container).ok_or("Не удалось найти устройство")?;
    let eps = endpoints_of(&guid);
    if eps.is_empty() {
        return Err("Это не наушники и не колонка: подключи его в Параметрах Windows".into());
    }
    // KSPROPSETID_BtAudio: 0 = one-shot reconnect, 1 = one-shot disconnect.
    let set = GUID::from_u128(0x7fa06c40_b8f6_4c7e_8556_e8c33a12e54d);
    let mut last = String::new();
    for (dev, _) in eps {
        let r: windows::core::Result<()> = unsafe {
            (|| {
                let topo: IDeviceTopology = dev.Activate(CLSCTX_ALL, None)?;
                let conn: IConnector = topo.GetConnector(0)?;
                let other: IConnector = conn.GetConnectedTo()?;
                let part: IPart = other.cast()?;
                let mut raw = std::ptr::null_mut();
                part.Activate(CLSCTX_ALL.0, &IKsControl::IID, Some(&mut raw))?;
                let ks = IKsControl::from_raw(raw);
                let prop = KSIDENTIFIER {
                    Anonymous: KSIDENTIFIER_0 { Anonymous: KSIDENTIFIER_0_0 { Set: set, Id: if on { 0 } else { 1 }, Flags: 1 } },
                };
                let mut got = 0u32;
                ks.KsProperty(&prop, std::mem::size_of::<KSIDENTIFIER>() as u32, std::ptr::null_mut(), 0, &mut got)
            })()
        };
        match r {
            Ok(()) => return Ok(()),
            Err(e) => last = e.message(),
        }
    }
    Err(format!("Windows не дал {}: {last}", if on { "подключить" } else { "отключить" }))
}

fn parse_guid(s: &str) -> Option<GUID> {
    // Debug form of GUID: 7FA06C40-B8F6-4C7E-8556-E8C33A12E54D
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    u128::from_str_radix(&hex, 16).ok().map(GUID::from_u128)
}

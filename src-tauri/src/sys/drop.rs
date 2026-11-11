//! Our own drop target for files dragged onto the island.
//!
//! Tauri registers its target on the webview's child windows once, when the
//! window is created; the island starts hidden, and WebView2 creates the
//! window that actually takes the mouse later, so dropped files never
//! arrived. This registers on every child window, including later ones.

use std::collections::HashSet;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use windows::core::{implement, Ref, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

#[implement(IDropTarget)]
struct Target {
    app: AppHandle,
    has_files: Mutex<bool>,
}

unsafe fn files(data: &Ref<'_, IDataObject>) -> Vec<String> {
    let Some(data) = data.as_ref() else { return Vec::new() };
    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let Ok(mut medium) = data.GetData(&fmt) else { return Vec::new() };
    let hdrop = HDROP(medium.u.hGlobal.0 as _);
    let n = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
    let mut out = Vec::new();
    for i in 0..n {
        let len = DragQueryFileW(hdrop, i, None) as usize;
        let mut buf = vec![0u16; len + 1];
        DragQueryFileW(hdrop, i, Some(&mut buf));
        out.push(OsString::from_wide(&buf[..len]).to_string_lossy().into_owned());
    }
    ReleaseStgMedium(&mut medium);
    out
}

impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let ok = unsafe { !files(&data).is_empty() };
        *self.has_files.lock().unwrap() = ok;
        unsafe { *effect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        if ok {
            crate::diag::log(&self.app, "drop: files entered the island");
            let _ = self.app.emit_to("island", "drag", serde_json::json!({ "type": "enter", "paths": [] }));
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let ok = *self.has_files.lock().unwrap();
        unsafe { *effect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        let _ = self.app.emit_to("island", "drag", serde_json::json!({ "type": "leave", "paths": [] }));
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let paths = unsafe { files(&data) };
        unsafe { *effect = if paths.is_empty() { DROPEFFECT_NONE } else { DROPEFFECT_COPY } };
        crate::diag::log(&self.app, &format!("drop: {} file(s)", paths.len()));
        crate::shelf_dropped(&self.app, paths);
        Ok(())
    }
}

static REGISTERED: Mutex<Option<HashSet<isize>>> = Mutex::new(None);

/// Registers the drop target on the window and all its child windows that
/// don't have ours yet. Must run on the window's (UI) thread; cheap to repeat.
pub fn register(app: &AppHandle, hwnd: isize) {
    let mut all = vec![hwnd];
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        let v = &mut *(l.0 as *mut Vec<isize>);
        v.push(h.0 as isize);
        BOOL(1)
    }
    unsafe {
        let _ = EnumChildWindows(Some(HWND(hwnd as _)), Some(collect), LPARAM(&mut all as *mut _ as isize));
    }
    let mut guard = REGISTERED.lock().unwrap();
    let done = guard.get_or_insert_with(HashSet::new);
    for h in all {
        if done.contains(&h) {
            continue;
        }
        let target: IDropTarget = Target { app: app.clone(), has_files: Mutex::new(false) }.into();
        unsafe {
            let _ = RevokeDragDrop(HWND(h as _));
            if RegisterDragDrop(HWND(h as _), &target).is_ok() {
                done.insert(h);
            }
        }
    }
}

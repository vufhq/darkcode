// Frameless window chrome.
//
// The OS caption is a light-grey bar on a pure-black app, and it is the one
// surface the palette cannot reach — so the app draws its own. Removing the
// frame is easy; keeping everything the frame gave you is the work:
//
//   * resize from all eight edges          → WM_NCHITTEST
//   * snap layouts, Win+Arrow, shake       → keep WS_OVERLAPPEDWINDOW
//   * the drop shadow                      → a 1px DWM frame extension
//   * maximise without covering the taskbar → WM_GETMINMAXINFO
//   * maximise without clipping the content → inset by the invisible border
//
// The app tells this layer where its own title strip and window buttons are,
// in physical pixels, so hit-testing can hand the caption back to Windows for
// dragging while leaving the buttons to ImGui.
#pragma once

#include <windows.h>

namespace dc::window {

/// Call once, after CreateWindow and before showing it.
void makeFrameless(HWND hwnd);

/// Geometry of the app-drawn title strip, in physical pixels, refreshed each
/// frame. `controlsWidth` is measured from the right edge and is excluded from
/// the drag region so the buttons stay clickable.
void setTitleBar(float height, float controlsWidth);

/// Returns true when the message was fully handled and `result` should be
/// returned from the window procedure.
bool handleMessage(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam, LRESULT* result);

bool isMaximized(HWND hwnd);
void minimize(HWND hwnd);
void toggleMaximize(HWND hwnd);
void close(HWND hwnd);

/// Windows' equivalent of prefers-reduced-motion. Re-read on WM_SETTINGCHANGE.
bool animationsEnabled();
void refreshAnimationSetting();

} // namespace dc::window

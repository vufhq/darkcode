#include "window.h"

#include <dwmapi.h>
#include <shellapi.h>
#include <windowsx.h>

namespace dc::window {
namespace {

float g_titleBarHeight = 38.0f;
float g_controlsWidth = 138.0f;
bool g_animationsEnabled = true;

/// Width of the invisible resize border Windows keeps around a frameless
/// window. It is also exactly how much a maximised window overhangs the work
/// area on each side, which is why the same number appears in both places.
int resizeBorderThickness(HWND hwnd) {
    const UINT dpi = ::GetDpiForWindow(hwnd);
    const int frame = ::GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi);
    const int padding = ::GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
    return frame + padding;
}

/// The grab strip along each edge. Deliberately a little wider than the visible
/// border: an 8px target is the difference between "resizable" and "fiddly".
int grabThickness(HWND hwnd) {
    const UINT dpi = ::GetDpiForWindow(hwnd);
    return ::MulDiv(8, static_cast<int>(dpi), 96);
}

LRESULT hitTest(HWND hwnd, POINT screenPoint) {
    RECT window{};
    ::GetWindowRect(hwnd, &window);

    // A maximised window has no edges to grab.
    const bool maximized = isMaximized(hwnd);
    const int grab = maximized ? 0 : grabThickness(hwnd);

    const bool left = screenPoint.x < window.left + grab;
    const bool right = screenPoint.x >= window.right - grab;
    const bool top = screenPoint.y < window.top + grab;
    const bool bottom = screenPoint.y >= window.bottom - grab;

    if (top && left) return HTTOPLEFT;
    if (top && right) return HTTOPRIGHT;
    if (bottom && left) return HTBOTTOMLEFT;
    if (bottom && right) return HTBOTTOMRIGHT;
    if (left) return HTLEFT;
    if (right) return HTRIGHT;
    if (top) return HTTOP;
    if (bottom) return HTBOTTOM;

    // Inside the app-drawn title strip, minus the window buttons, is caption:
    // Windows then owns dragging, double-click-to-maximise and the shake
    // gesture for free.
    const float y = static_cast<float>(screenPoint.y - window.top);
    const float x = static_cast<float>(screenPoint.x - window.left);
    const float width = static_cast<float>(window.right - window.left);
    if (y < g_titleBarHeight && x < width - g_controlsWidth) return HTCAPTION;

    return HTCLIENT;
}

} // namespace

void makeFrameless(HWND hwnd) {
    // One pixel of frame is enough for DWM to draw the shadow and to keep the
    // window participating in snap and Aero Peek. Extending the full frame
    // would let the caption paint over the client area.
    const MARGINS shadow{0, 0, 1, 0};
    ::DwmExtendFrameIntoClientArea(hwnd, &shadow);

    refreshAnimationSetting();

    // Force a frame recalculation so WM_NCCALCSIZE runs with the new geometry.
    ::SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                   SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void setTitleBar(float height, float controlsWidth) {
    g_titleBarHeight = height;
    g_controlsWidth = controlsWidth;
}

bool isMaximized(HWND hwnd) {
    WINDOWPLACEMENT placement{};
    placement.length = sizeof(placement);
    if (!::GetWindowPlacement(hwnd, &placement)) return false;
    return placement.showCmd == SW_SHOWMAXIMIZED;
}

void minimize(HWND hwnd) { ::ShowWindow(hwnd, SW_MINIMIZE); }

void toggleMaximize(HWND hwnd) {
    ::ShowWindow(hwnd, isMaximized(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
}

void close(HWND hwnd) { ::PostMessageW(hwnd, WM_CLOSE, 0, 0); }

bool animationsEnabled() { return g_animationsEnabled; }

void refreshAnimationSetting() {
    BOOL enabled = TRUE;
    if (::SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0)) {
        g_animationsEnabled = enabled != FALSE;
    }
}

bool handleMessage(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam, LRESULT* result) {
    switch (message) {
        case WM_NCCALCSIZE: {
            if (wParam == FALSE) return false;

            NCCALCSIZE_PARAMS* params = reinterpret_cast<NCCALCSIZE_PARAMS*>(lParam);
            // Always start from the proposed window rect — the whole frame,
            // caption included. Letting DefWindowProc compute the rect first
            // and then adjusting it leaves the caption strip reserved, and
            // Windows paints its own title bar into it.
            RECT& client = params->rgrc[0];

            if (isMaximized(hwnd)) {
                // A maximised window is deliberately larger than the work area
                // by the resize border on every side. Inset by exactly that, or
                // the edges bleed onto the next monitor and the top is clipped.
                const int border = resizeBorderThickness(hwnd);
                client.left += border;
                client.right -= border;
                client.top += border;
                client.bottom -= border;

                // With an auto-hide taskbar Windows needs a pixel of
                // non-client edge left on that side, or the bar can no longer
                // be summoned while the window is maximised.
                APPBARDATA appBar{};
                appBar.cbSize = sizeof(appBar);
                if (::SHAppBarMessage(ABM_GETSTATE, &appBar) & ABS_AUTOHIDE) {
                    client.bottom -= 1;
                }
            }

            *result = 0;
            return true;
        }

        case WM_NCHITTEST: {
            const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            *result = hitTest(hwnd, point);
            return true;
        }

        case WM_GETMINMAXINFO: {
            // Windows' own maximised geometry is correct — work area plus the
            // resize border on each side — and WM_NCCALCSIZE above insets the
            // client back to exactly the work area. Overriding it here instead
            // fights the multi-monitor and taskbar handling, so only the
            // minimum size is ours.
            ::DefWindowProcW(hwnd, message, wParam, lParam);

            MINMAXINFO* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
            const UINT dpi = ::GetDpiForWindow(hwnd);
            mmi->ptMinTrackSize.x = ::MulDiv(880, static_cast<int>(dpi), 96);
            mmi->ptMinTrackSize.y = ::MulDiv(560, static_cast<int>(dpi), 96);

            *result = 0;
            return true;
        }

        case WM_SETTINGCHANGE:
            refreshAnimationSetting();
            return false; // let the backend see it too

        default:
            return false;
    }
}

} // namespace dc::window

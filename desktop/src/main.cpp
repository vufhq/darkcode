// Win32 + Direct3D 11 host for the app. Structure follows Dear ImGui's
// example_win32_directx11 backend sample; everything above the frame loop is
// in App.
#include <windows.h>
#include <d3d11.h>
#include <dwmapi.h>

#include "imgui.h"
#include "imgui_impl_dx11.h"
#include "imgui_impl_win32.h"

#include "app.h"
#include "theme.h"
#include "util.h"

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

namespace {

ID3D11Device* g_device = nullptr;
ID3D11DeviceContext* g_context = nullptr;
IDXGISwapChain* g_swapChain = nullptr;
ID3D11RenderTargetView* g_renderTarget = nullptr;
bool g_swapChainOccluded = false;
UINT g_resizeWidth = 0;
UINT g_resizeHeight = 0;

void createRenderTarget() {
    ID3D11Texture2D* backBuffer = nullptr;
    g_swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
    if (!backBuffer) return;
    g_device->CreateRenderTargetView(backBuffer, nullptr, &g_renderTarget);
    backBuffer->Release();
}

void cleanupRenderTarget() {
    if (g_renderTarget) {
        g_renderTarget->Release();
        g_renderTarget = nullptr;
    }
}

bool createDevice(HWND hwnd) {
    DXGI_SWAP_CHAIN_DESC description{};
    description.BufferCount = 2;
    description.BufferDesc.Width = 0;
    description.BufferDesc.Height = 0;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.BufferDesc.RefreshRate.Numerator = 60;
    description.BufferDesc.RefreshRate.Denominator = 1;
    description.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.OutputWindow = hwnd;
    description.SampleDesc.Count = 1;
    description.SampleDesc.Quality = 0;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    UINT flags = 0;
    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL levels[2] = {D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};

    HRESULT result = ::D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                                                     levels, 2, D3D11_SDK_VERSION, &description,
                                                     &g_swapChain, &g_device, &featureLevel, &g_context);
    if (result == DXGI_ERROR_UNSUPPORTED) {
        // No GPU (or a remote session): WARP is slower but always available.
        result = ::D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, levels, 2,
                                                 D3D11_SDK_VERSION, &description, &g_swapChain, &g_device,
                                                 &featureLevel, &g_context);
    }
    if (result != S_OK) return false;

    createRenderTarget();
    return true;
}

void cleanupDevice() {
    cleanupRenderTarget();
    if (g_swapChain) {
        g_swapChain->Release();
        g_swapChain = nullptr;
    }
    if (g_context) {
        g_context->Release();
        g_context = nullptr;
    }
    if (g_device) {
        g_device->Release();
        g_device = nullptr;
    }
}

LRESULT WINAPI windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hwnd, message, wParam, lParam)) return true;

    switch (message) {
        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) return 0;
            g_resizeWidth = static_cast<UINT>(LOWORD(lParam));
            g_resizeHeight = static_cast<UINT>(HIWORD(lParam));
            return 0;
        case WM_SYSCOMMAND:
            if ((wParam & 0xfff0) == SC_KEYMENU) return 0; // no alt-menu
            break;
        case WM_DESTROY:
            ::PostQuitMessage(0);
            return 0;
        default:
            break;
    }
    return ::DefWindowProcW(hwnd, message, wParam, lParam);
}

/// Matches the title bar to the app's dark palette. Fails silently on builds
/// of Windows that predate the attribute.
void useDarkTitleBar(HWND hwnd) {
    BOOL enabled = TRUE;
    ::DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &enabled, sizeof(enabled));
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    // Needed by the folder picker (IFileDialog) in Settings.
    ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

    ImGui_ImplWin32_EnableDpiAwareness();

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_CLASSDC;
    windowClass.lpfnWndProc = windowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = ::LoadCursor(nullptr, IDC_ARROW);
    windowClass.lpszClassName = L"DarkCodeDesktop";
    ::RegisterClassExW(&windowClass);

    HWND hwnd = ::CreateWindowW(windowClass.lpszClassName, L"DarkCode", WS_OVERLAPPEDWINDOW, 100, 100,
                                1360, 900, nullptr, nullptr, instance, nullptr);
    if (!hwnd) {
        ::UnregisterClassW(windowClass.lpszClassName, instance);
        return 1;
    }
    useDarkTitleBar(hwnd);

    if (!createDevice(hwnd)) {
        cleanupDevice();
        ::DestroyWindow(hwnd);
        ::UnregisterClassW(windowClass.lpszClassName, instance);
        ::MessageBoxW(nullptr, L"Could not create a Direct3D 11 device.", L"DarkCode", MB_ICONERROR);
        return 1;
    }

    ::ShowWindow(hwnd, SW_SHOWDEFAULT);
    ::UpdateWindow(hwnd);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = nullptr; // no layout file to keep in sync with the code

    const float dpiScale = ImGui_ImplWin32_GetDpiScaleForHwnd(hwnd);
    dc::theme::applyStyle(dpiScale);
    const dc::theme::Fonts fonts = dc::theme::loadFonts(dpiScale);

    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX11_Init(g_device, g_context);

    {
        dc::App app;
        app.setFonts(fonts);

        bool done = false;
        while (!done) {
            MSG message;
            while (::PeekMessageW(&message, nullptr, 0U, 0U, PM_REMOVE)) {
                ::TranslateMessage(&message);
                ::DispatchMessageW(&message);
                if (message.message == WM_QUIT) done = true;
            }
            if (done) break;

            if (g_swapChainOccluded && g_swapChain->Present(0, DXGI_PRESENT_TEST) == DXGI_STATUS_OCCLUDED) {
                ::Sleep(10);
                continue;
            }
            g_swapChainOccluded = false;

            if (g_resizeWidth != 0 && g_resizeHeight != 0) {
                cleanupRenderTarget();
                g_swapChain->ResizeBuffers(0, g_resizeWidth, g_resizeHeight, DXGI_FORMAT_UNKNOWN, 0);
                g_resizeWidth = g_resizeHeight = 0;
                createRenderTarget();
            }

            ImGui_ImplDX11_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();

            app.tick();
            app.render();

            ImGui::Render();
            const ImVec4& background = dc::theme::kBackground;
            const float clearColor[4] = {background.x, background.y, background.z, 1.0f};
            g_context->OMSetRenderTargets(1, &g_renderTarget, nullptr);
            g_context->ClearRenderTargetView(g_renderTarget, clearColor);
            ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

            const HRESULT present = g_swapChain->Present(1, 0); // vsync
            g_swapChainOccluded = (present == DXGI_STATUS_OCCLUDED);
        }
    } // App is destroyed here, while ImGui and D3D are still alive.

    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();

    cleanupDevice();
    ::DestroyWindow(hwnd);
    ::UnregisterClassW(windowClass.lpszClassName, instance);
    ::CoUninitialize();
    return 0;
}

#include <winsock2.h>
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <psapi.h>
#include <wincrypt.h>
#include <shobjidl.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cmath>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <unordered_map>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
constexpr UINT commandMessage = WM_APP + 1, trayMessage = WM_APP + 2;
constexpr UINT backendExitMessage = WM_APP + 3;
constexpr int toolbarHeight = 36, tabHeight = 30;
struct Tab {
    std::string id, profile, targetId;
    std::wstring url;
    bool leased = false, loading = true;
    std::uint64_t requestId = 0;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> view;
    EventRegistrationToken starting{}, completed{}, failed{};
    EventRegistrationToken webMessage{}, sourceChanged{};
    EventRegistrationToken newWindow{};
    std::wstring startupScript;
    bool applicationUi = false, customBounds = false, visible = true;
    RECT requestedBounds{};
    struct Subscription { ComPtr<ICoreWebView2DevToolsProtocolEventReceiver> receiver; EventRegistrationToken token{}; };
    std::vector<Subscription> subscriptions;
};
HWND mainWindow = nullptr, tabStrip = nullptr, addressBox = nullptr, newButton = nullptr, goButton = nullptr;
ComPtr<ICoreWebView2Environment> environment;
std::vector<std::unique_ptr<Tab>> tabs;
std::string selectedTab;
NOTIFYICONDATAW tray{};
std::atomic_bool shuttingDown = false;
int debugPort = 0;
bool applicationMode = false;
const std::string uiTabId = "launcher_ui";
struct PendingPopup { ComPtr<ICoreWebView2NewWindowRequestedEventArgs> args; ComPtr<ICoreWebView2Deferral> deferral; };
std::unordered_map<std::string, PendingPopup> pendingPopups;
std::uint64_t popupSequence = 0;
std::wstring trayOpen = L"열기", trayQuit = L"종료";
HANDLE backendProcess = nullptr;
bool controlledMode = true;

int availablePort() {
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) throw std::runtime_error("Loopback socket initialization failed");
    const auto socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int size = sizeof(address); bool valid = socket != INVALID_SOCKET && bind(socket, reinterpret_cast<sockaddr*>(&address), size) == 0 && getsockname(socket, reinterpret_cast<sockaddr*>(&address), &size) == 0;
    if (socket != INVALID_SOCKET) closesocket(socket); WSACleanup();
    if (!valid) throw std::runtime_error("Loopback debugging port unavailable"); return ntohs(address.sin_port);
}

std::wstring executablePath() {
    std::wstring result(32768, L'\0'); const DWORD size = GetModuleFileNameW(nullptr, result.data(), static_cast<DWORD>(result.size()));
    if (!size || size >= result.size()) throw std::runtime_error("Native executable path unavailable"); result.resize(size); return result;
}
std::wstring commandArgument(const std::wstring& argument) {
    std::wstring result = L"\""; std::size_t slashes = 0;
    for (const auto c : argument) {
        if (c == L'\\') { ++slashes; continue; }
        result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); result += c; slashes = 0;
    }
    result.append(slashes * 2, L'\\'); return result + L'"';
}
void startBackend(const std::wstring& userDataFolder, bool hidden, bool offline) {
    const auto executable = executablePath(); const auto root = std::filesystem::path(executable).parent_path();
    const auto bun = root / L"backend" / L"bun.exe", entry = root / L"backend" / L"entry.cjs";
    if (!std::filesystem::is_regular_file(bun) || !std::filesystem::is_regular_file(entry)) throw std::runtime_error("Native launcher backend package is missing");
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE}; HANDLE hostInput = nullptr, childOutput = nullptr, childInput = nullptr, hostOutput = nullptr;
    if (!CreatePipe(&hostInput, &childOutput, &security, 0) || !CreatePipe(&childInput, &hostOutput, &security, 0)) throw std::runtime_error("Native backend pipe creation failed");
    SetHandleInformation(hostInput, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(hostOutput, HANDLE_FLAG_INHERIT, 0);
    const auto logPath = std::filesystem::path(userDataFolder).parent_path() / L"native-backend.stderr.log";
    HANDLE log = CreateFileW(logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    startup.hStdInput = childInput; startup.hStdOutput = childOutput; startup.hStdError = log;
    auto command = commandArgument(bun.wstring()) + L" " + commandArgument(entry.wstring()) + L" --native-executable " + commandArgument(executable) + L" --user-data-folder " + commandArgument(userDataFolder);
    if (hidden) command += L" --hidden"; if (offline) command += L" --offline";
    PROCESS_INFORMATION child{};
    const BOOL started = CreateProcessW(bun.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &child);
    CloseHandle(childInput); CloseHandle(childOutput); if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
    if (!started) { CloseHandle(hostInput); CloseHandle(hostOutput); throw std::runtime_error("Native backend process could not start"); }
    CloseHandle(child.hThread); backendProcess = child.hProcess;
    SetStdHandle(STD_INPUT_HANDLE, hostInput); SetStdHandle(STD_OUTPUT_HANDLE, hostOutput);
    std::thread([] { WaitForSingleObject(backendProcess, INFINITE); if (!shuttingDown) PostMessageW(mainWindow, backendExitMessage, 0, 0); }).detach();
}

std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size, nullptr, nullptr);
    return result;
}
std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (!size) throw std::runtime_error("Invalid UTF-8 command");
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}
std::string quote(const std::string& text) {
    std::string result = "\"";
    for (const unsigned char value : text) {
        if (value == '"' || value == '\\') { result += '\\'; result += static_cast<char>(value); }
        else if (value < 32) { const char hex[] = "0123456789abcdef"; result += "\\u00"; result += hex[value >> 4]; result += hex[value & 15]; }
        else result += static_cast<char>(value);
    }
    return result + '"';
}
void emit(const std::string& value) {
    const auto text = value + '\n';
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
}
void reply(std::uint64_t id, const std::string& fields) { emit("{\"id\":" + std::to_string(id) + "," + fields + "}"); }
void failure(std::uint64_t id, const std::string& message, HRESULT code = E_FAIL) {
    reply(id, "\"ok\":false,\"error\":" + quote(message) + ",\"hresult\":" + std::to_string(static_cast<unsigned long>(code)));
}
Tab* findTab(const std::string& id) {
    const auto found = std::find_if(tabs.begin(), tabs.end(), [&](const auto& tab) { return tab->id == id; });
    return found == tabs.end() ? nullptr : found->get();
}
bool validName(const std::string& text) {
    return !text.empty() && text.size() <= 64 && std::all_of(text.begin(), text.end(), [](unsigned char value) {
        return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '-' || value == '_';
    });
}
void layout() {
    if (!mainWindow) return;
    RECT client{}; GetClientRect(mainWindow, &client);
    const LONG width = std::max<LONG>(320, client.right), height = std::max<LONG>(240, client.bottom - toolbarHeight - tabHeight);
    MoveWindow(tabStrip, 0, toolbarHeight, width, tabHeight, TRUE);
    MoveWindow(addressBox, 76, 5, std::max<LONG>(100, width - 156), 25, TRUE);
    MoveWindow(goButton, width - 72, 5, 64, 25, TRUE);
    for (const auto control : {tabStrip, addressBox, newButton, goButton}) ShowWindow(control, applicationMode ? SW_HIDE : SW_SHOW);
    for (const auto& tab : tabs) {
        if (!tab->controller) continue;
        const bool selected = tab->id == selectedTab;
        // Keep leased pages drawable with a nonzero viewport; visual tab selection must not end a turn.
        RECT bounds{selected ? 0L : -width - 128, toolbarHeight + tabHeight, selected ? width : -128L, toolbarHeight + tabHeight + height};
        if (tab->applicationUi) bounds = client;
        else if (tab->customBounds) bounds = tab->requestedBounds;
        tab->controller->put_Bounds(bounds);
        tab->controller->put_IsVisible(tab->applicationUi || (tab->customBounds ? tab->visible : selected) || tab->leased ? TRUE : FALSE);
    }
}
void selectTab(const std::string& id) {
    auto* tab = findTab(id);
    if (!tab) return;
    selectedTab = id;
    for (std::size_t index = 0; index < tabs.size(); ++index) if (tabs[index]->id == id) TabCtrl_SetCurSel(tabStrip, static_cast<int>(index));
    SetWindowTextW(addressBox, tab->url.c_str());
    layout();
}
void removeTab(std::string id) {
    const auto found = std::find_if(tabs.begin(), tabs.end(), [&](const auto& tab) { return tab->id == id; });
    if (found == tabs.end()) return;
    const int index = static_cast<int>(std::distance(tabs.begin(), found));
    auto& tab = **found;
    if (tab.view) {
        tab.view->remove_NavigationStarting(tab.starting);
        tab.view->remove_NavigationCompleted(tab.completed);
        tab.view->remove_ProcessFailed(tab.failed);
        tab.view->remove_WebMessageReceived(tab.webMessage);
        tab.view->remove_SourceChanged(tab.sourceChanged);
        tab.view->remove_NewWindowRequested(tab.newWindow);
        for (const auto& subscription : tab.subscriptions) subscription.receiver->remove_DevToolsProtocolEventReceived(subscription.token);
    }
    if (tab.controller) tab.controller->Close();
    // Explicit close and event removal release the COM graph rather than relying on process exit.
    tab.view.Reset(); tab.controller.Reset();
    tabs.erase(found);
    TabCtrl_DeleteItem(tabStrip, index);
    if (selectedTab == id) { selectedTab.clear(); if (!tabs.empty()) selectTab(tabs.back()->id); }
    layout();
}
std::string memoryRow(DWORD pid, int kind) {
    const HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    PROCESS_MEMORY_COUNTERS_EX counters{}; counters.cb = sizeof(counters);
    const bool available = process && GetProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters));
    if (process) CloseHandle(process);
    return "{\"pid\":" + std::to_string(pid) + ",\"kind\":" + std::to_string(kind) + ",\"available\":" + (available ? "true" : "false")
        + ",\"privateBytes\":" + std::to_string(counters.PrivateUsage) + ",\"workingSetBytes\":" + std::to_string(counters.WorkingSetSize) + "}";
}
void snapshot(std::uint64_t id) {
    std::string rows = "[";
    for (std::size_t index = 0; index < tabs.size(); ++index) {
        const auto& tab = *tabs[index]; if (index) rows += ',';
        RECT bounds{}; if (tab.controller) tab.controller->get_Bounds(&bounds);
        rows += "{\"tabId\":" + quote(tab.id) + ",\"profile\":" + quote(tab.profile) + ",\"targetId\":" + quote(tab.targetId)
            + ",\"leased\":" + (tab.leased ? "true" : "false") + ",\"loading\":" + (tab.loading ? "true" : "false")
            + ",\"width\":" + std::to_string(bounds.right - bounds.left) + ",\"height\":" + std::to_string(bounds.bottom - bounds.top) + "}";
    }
    rows += ']';
    std::string processes = "[" + memoryRow(GetCurrentProcessId(), -1);
    ComPtr<ICoreWebView2Environment8> processEnvironment;
    if (environment && SUCCEEDED(environment.As(&processEnvironment))) {
        ComPtr<ICoreWebView2ProcessInfoCollection> infos;
        if (SUCCEEDED(processEnvironment->GetProcessInfos(&infos))) {
            UINT count = 0; infos->get_Count(&count);
            for (UINT index = 0; index < count; ++index) {
                ComPtr<ICoreWebView2ProcessInfo> info;
                if (FAILED(infos->GetValueAtIndex(index, &info))) continue;
                INT32 pid = 0; COREWEBVIEW2_PROCESS_KIND kind{}; info->get_ProcessId(&pid); info->get_Kind(&kind);
                processes += ',' + memoryRow(static_cast<DWORD>(pid), static_cast<int>(kind));
            }
        }
    }
    processes += ']';
    RECT client{}, window{}; GetClientRect(mainWindow, &client); GetWindowRect(mainWindow, &window);
    const double scale = static_cast<double>(GetDpiForWindow(mainWindow)) / 96;
    reply(id, "\"ok\":true,\"selectedTab\":" + quote(selectedTab) + ",\"visible\":" + (IsWindowVisible(mainWindow) ? "true" : "false")
        + ",\"minimized\":" + (IsIconic(mainWindow) ? "true" : "false") + ",\"maximized\":" + (IsZoomed(mainWindow) ? "true" : "false")
        + ",\"contentWidth\":" + std::to_string(client.right / scale) + ",\"contentHeight\":" + std::to_string(client.bottom / scale)
        + ",\"windowBounds\":{\"x\":" + std::to_string(window.left / scale) + ",\"y\":" + std::to_string(window.top / scale)
        + ",\"width\":" + std::to_string((window.right - window.left) / scale) + ",\"height\":" + std::to_string((window.bottom - window.top) / scale)
        + "},\"tabs\":" + rows + ",\"processes\":" + processes);
}

std::string targetIdFromJson(const std::wstring& text) {
    const auto value = utf8(text);
    const auto key = value.find("\"targetId\"");
    if (key == std::string::npos) return {};
    const auto colon = value.find(':', key), first = value.find('"', colon), last = value.find('"', first + 1);
    if (colon == std::string::npos || first == std::string::npos || last == std::string::npos) return {};
    const auto target = value.substr(first + 1, last - first - 1);
    return validName(target) ? target : std::string{};
}
void createTab(std::uint64_t requestId, const std::string& id, const std::string& profile, const std::wstring& url, bool leased, bool selected, const std::wstring& startupScript = L"") {
    if (!environment || !validName(id) || !validName(profile) || findTab(id)) { failure(requestId, "Environment, tab identity or profile unavailable"); return; }
    ComPtr<ICoreWebView2Environment10> profileEnvironment;
    ComPtr<ICoreWebView2ControllerOptions> options;
    HRESULT result = environment.As(&profileEnvironment);
    if (SUCCEEDED(result)) result = profileEnvironment->CreateCoreWebView2ControllerOptions(&options);
    if (SUCCEEDED(result)) result = options->put_ProfileName(wide(profile).c_str());
    if (FAILED(result)) { failure(requestId, "WebView2 profile creation unavailable", result); return; }
    auto tab = std::make_unique<Tab>();
    tab->id = id; tab->profile = profile; tab->url = url; tab->leased = leased; tab->requestId = requestId;
    tab->applicationUi = id == uiTabId; tab->startupScript = startupScript;
    tabs.push_back(std::move(tab));
    auto label = L"ChatGPT " + std::to_wstring(tabs.size());
    TCITEMW item{}; item.mask = TCIF_TEXT; item.pszText = label.data();
    TabCtrl_InsertItem(tabStrip, static_cast<int>(tabs.size()) - 1, &item);
    if (selected || selectedTab.empty()) selectTab(id);
    result = profileEnvironment->CreateCoreWebView2ControllerWithOptions(mainWindow, options.Get(),
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([id, requestId](HRESULT status, ICoreWebView2Controller* controller) -> HRESULT {
            auto* current = findTab(id);
            if (!current || shuttingDown) { if (controller) controller->Close(); return S_OK; }
            if (FAILED(status) || !controller) { failure(requestId, "WebView2 controller initialization failed", status); removeTab(id); return S_OK; }
            current->controller = controller;
            status = controller->get_CoreWebView2(&current->view);
            if (FAILED(status)) { failure(requestId, "WebView2 document unavailable", status); removeTab(id); return S_OK; }
            ComPtr<ICoreWebView2Settings> settings;
            if (SUCCEEDED(current->view->get_Settings(&settings))) settings->put_IsStatusBarEnabled(FALSE);
            current->view->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([id](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                if (auto* owned = findTab(id)) {
                    LPWSTR uri = nullptr; args->get_Uri(&uri);
                    if (owned->applicationUi && uri) {
                        auto requested = std::wstring(uri); const auto hash = requested.find(L'#'); if (hash != std::wstring::npos) requested.resize(hash);
                        if (requested != owned->url) args->put_Cancel(TRUE);
                    }
                    if (uri) CoTaskMemFree(uri);
                    owned->loading = true;
                }
                return S_OK;
            }).Get(), &current->starting);
            current->view->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([id](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                auto* owned = findTab(id); if (!owned) return S_OK;
                owned->loading = false;
                LPWSTR source = nullptr;
                if (SUCCEEDED(sender->get_Source(&source))) { owned->url = source; CoTaskMemFree(source); }
                if (id == selectedTab) SetWindowTextW(addressBox, owned->url.c_str());
                BOOL success = FALSE; args->get_IsSuccess(&success);
                BOOL back = FALSE, forward = FALSE; sender->get_CanGoBack(&back); sender->get_CanGoForward(&forward);
                LPWSTR title = nullptr; sender->get_DocumentTitle(&title);
                COREWEBVIEW2_WEB_ERROR_STATUS error{}; args->get_WebErrorStatus(&error);
                emit("{\"event\":\"navigation-completed\",\"tabId\":" + quote(id) + ",\"success\":" + (success ? "true" : "false")
                    + ",\"url\":" + quote(utf8(owned->url)) + ",\"title\":" + quote(title ? utf8(title) : "") + ",\"canGoBack\":" + (back ? "true" : "false")
                    + ",\"canGoForward\":" + (forward ? "true" : "false") + ",\"errorCode\":" + std::to_string(static_cast<int>(error)) + "}");
                if (title) CoTaskMemFree(title);
                return S_OK;
            }).Get(), &current->completed);
            current->view->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([id](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PROCESS_FAILED_KIND kind{}; args->get_ProcessFailedKind(&kind);
                emit("{\"event\":\"process-failed\",\"tabId\":" + quote(id) + ",\"kind\":" + std::to_string(static_cast<int>(kind)) + "}");
                return S_OK;
            }).Get(), &current->failed);
            current->view->add_SourceChanged(Callback<ICoreWebView2SourceChangedEventHandler>([id](ICoreWebView2* sender, ICoreWebView2SourceChangedEventArgs*) -> HRESULT {
                auto* owned = findTab(id); if (!owned) return S_OK;
                LPWSTR source = nullptr; sender->get_Source(&source);
                if (source) { if (!owned->applicationUi) owned->url = source; emit("{\"event\":\"source-changed\",\"tabId\":" + quote(id) + ",\"url\":" + quote(utf8(source)) + "}"); CoTaskMemFree(source); }
                return S_OK;
            }).Get(), &current->sourceChanged);
            current->view->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([id](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                args->put_Handled(TRUE);
                auto* owned = findTab(id); if (!owned || owned->applicationUi) return S_OK;
                LPWSTR uri = nullptr; args->get_Uri(&uri);
                if (uri) {
                    PendingPopup pending; pending.args = args;
                    if (SUCCEEDED(args->GetDeferral(&pending.deferral))) {
                        const auto popupId = "popup_" + std::to_string(++popupSequence); pendingPopups.emplace(popupId, std::move(pending));
                        emit("{\"event\":\"new-window\",\"tabId\":" + quote(id) + ",\"popupId\":" + quote(popupId) + ",\"url\":" + quote(utf8(uri)) + "}");
                    }
                    CoTaskMemFree(uri);
                }
                return S_OK;
            }).Get(), &current->newWindow);
            if (current->applicationUi) {
                current->view->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([id](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                    auto* owned = findTab(id); if (!owned) return S_OK;
                    LPWSTR source = nullptr, json = nullptr; args->get_Source(&source); args->get_WebMessageAsJson(&json);
                    if (source && json && std::wstring(source) == owned->url && wcslen(json) <= 1048576) {
                        emit("{\"event\":\"ui-message\",\"value\":" + utf8(json) + "}");
                    }
                    if (source) CoTaskMemFree(source); if (json) CoTaskMemFree(json);
                    return S_OK;
                }).Get(), &current->webMessage);
            }
            layout();
            status = current->view->CallDevToolsProtocolMethod(L"Target.getTargetInfo", L"{}",
                Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>([id, requestId](HRESULT status, LPCWSTR json) -> HRESULT {
                    auto* owned = findTab(id); if (!owned) return S_OK;
                    if (FAILED(status) || !json) { failure(requestId, "Owned CDP target inspection failed", status); removeTab(id); return S_OK; }
                    owned->targetId = targetIdFromJson(json);
                    if (owned->targetId.empty()) { failure(requestId, "WebView2 did not expose its owned CDP target"); removeTab(id); return S_OK; }
                    reply(requestId, "\"ok\":true,\"tabId\":" + quote(id) + ",\"profile\":" + quote(owned->profile) + ",\"targetId\":" + quote(owned->targetId));
                    if (!owned->startupScript.empty()) {
                        owned->view->AddScriptToExecuteOnDocumentCreated(owned->startupScript.c_str(), Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>([id](HRESULT scriptStatus, LPCWSTR) -> HRESULT {
                            auto* target = findTab(id); if (!target) return S_OK;
                            if (FAILED(scriptStatus)) { emit("{\"event\":\"ui-script-failed\"}"); return S_OK; }
                            target->view->Navigate(target->url.c_str()); return S_OK;
                        }).Get());
                    } else {
                        const HRESULT navigation = owned->view->Navigate(owned->url.c_str());
                        if (FAILED(navigation)) emit("{\"event\":\"navigation-failed\",\"tabId\":" + quote(id) + "}");
                    }
                    return S_OK;
                }).Get());
            if (FAILED(status)) { failure(requestId, "CDP target inspection could not start", status); removeTab(id); }
            return S_OK;
        }).Get());
    if (FAILED(result)) { failure(requestId, "Controller creation could not start", result); removeTab(id); }
}

std::wstring decodedText(const std::string& encoded, std::size_t limit = 1048576) {
    DWORD size = 0;
    if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr)) throw std::runtime_error("Invalid encoded URL");
    std::string value(size, '\0');
    if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, reinterpret_cast<BYTE*>(value.data()), &size, nullptr, nullptr)) throw std::runtime_error("Invalid encoded URL");
    if (value.size() > limit || value.find('\0') != std::string::npos) throw std::runtime_error("Encoded text exceeds its bound");
    return wide(value);
}
std::wstring decodedUrl(const std::string& encoded) {
    const auto value = decodedText(encoded, 16000);
    if (!(value.rfind(L"https://", 0) == 0 || value.rfind(L"http://", 0) == 0 || value == L"about:blank" || value.rfind(L"data:text/html", 0) == 0)) throw std::runtime_error("Unsupported navigation URL");
    return value;
}
bool flag(const std::string& value) {
    if (value != "0" && value != "1") throw std::runtime_error("Invalid boolean field");
    return value == "1";
}
void command(const std::string& line) {
    std::vector<std::string> fields; std::istringstream stream(line); std::string value;
    while (std::getline(stream, value, '\t')) fields.push_back(value);
    std::uint64_t requestId = 0;
    try {
        if (fields.size() < 2) throw std::runtime_error("Missing command identity");
        if (fields[1].empty() || fields[1].size() > 18 || !std::all_of(fields[1].begin(), fields[1].end(), [](char c) { return c >= '0' && c <= '9'; })) throw std::runtime_error("Invalid request identity");
        requestId = std::stoull(fields[1]);
        const auto& operation = fields[0];
        if (operation == "snapshot" && fields.size() == 2) { snapshot(requestId); return; }
        if (operation == "add" && fields.size() == 7) { if (fields[2] == uiTabId) throw std::runtime_error("Reserved application identity"); createTab(requestId, fields[2], fields[3], decodedUrl(fields[4]), flag(fields[5]), flag(fields[6])); return; }
        if (operation == "ui" && fields.size() == 4) {
            const auto url = decodedUrl(fields[2]);
            if (url.rfind(L"http://127.0.0.1:", 0) != 0) throw std::runtime_error("Application UI must use its loopback server");
            applicationMode = true; createTab(requestId, uiTabId, "launcher_ui", url, false, false, decodedText(fields[3])); layout(); return;
        }
        if (operation == "message" && fields.size() == 3) {
            auto* ui = findTab(uiTabId); if (!ui || !ui->view) throw std::runtime_error("Application UI unavailable");
            const HRESULT status = ui->view->PostWebMessageAsJson(decodedText(fields[2]).c_str());
            if (FAILED(status)) { failure(requestId, "Application message delivery failed", status); return; }
            reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "power" && fields.size() == 3) {
            const auto status = SetThreadExecutionState(ES_CONTINUOUS | (flag(fields[2]) ? ES_SYSTEM_REQUIRED : 0));
            if (!status) throw std::runtime_error("Power lease update failed"); reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "tray" && fields.size() == 5) {
            const auto title = decodedText(fields[2], 256); trayOpen = decodedText(fields[3], 256); trayQuit = decodedText(fields[4], 256);
            wcsncpy_s(tray.szTip, title.c_str(), _TRUNCATE); Shell_NotifyIconW(NIM_MODIFY, &tray); SetWindowTextW(mainWindow, title.c_str());
            reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "external" && fields.size() == 3) {
            const auto url = decodedUrl(fields[2]); if (url.rfind(L"https://", 0) != 0 && url.rfind(L"http://", 0) != 0) throw std::runtime_error("External target must be a web URL");
            if (reinterpret_cast<INT_PTR>(ShellExecuteW(mainWindow, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) throw std::runtime_error("External browser launch failed");
            reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "clipboard" && fields.size() == 3) {
            const auto text = decodedText(fields[2]); if (!OpenClipboard(mainWindow)) throw std::runtime_error("Clipboard unavailable");
            const auto size = (text.size() + 1) * sizeof(wchar_t); const HANDLE data = GlobalAlloc(GMEM_MOVEABLE, size);
            void* target = data ? GlobalLock(data) : nullptr;
            if (!target) { if (data) GlobalFree(data); CloseClipboard(); throw std::runtime_error("Clipboard allocation failed"); }
            memcpy(target, text.c_str(), size); GlobalUnlock(data); EmptyClipboard();
            if (!SetClipboardData(CF_UNICODETEXT, data)) { GlobalFree(data); CloseClipboard(); throw std::runtime_error("Clipboard write failed"); }
            CloseClipboard(); reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "confirm" && fields.size() == 5) {
            const auto title = decodedText(fields[2]), text = decodedText(fields[3]), detail = decodedText(fields[4]);
            const auto result = MessageBoxW(mainWindow, (text + L"\n\n" + detail).c_str(), title.c_str(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2);
            reply(requestId, "\"ok\":true,\"response\":" + std::to_string(result == IDYES ? 1 : 0)); return;
        }
        if (operation == "save" && fields.size() == 4) {
            ComPtr<IFileSaveDialog> dialog; HRESULT status = CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
            if (FAILED(status)) { failure(requestId, "Save dialog initialization failed", status); return; }
            const auto title = decodedText(fields[2]), file = decodedText(fields[3]); dialog->SetTitle(title.c_str()); dialog->SetFileName(std::filesystem::path(file).filename().c_str());
            const COMDLG_FILTERSPEC filters[] = {{L"JSON Lines", L"*.jsonl"}}; dialog->SetFileTypes(1, filters); dialog->SetDefaultExtension(L"jsonl");
            status = dialog->Show(mainWindow);
            if (status == HRESULT_FROM_WIN32(ERROR_CANCELLED)) { reply(requestId, "\"ok\":true,\"canceled\":true"); return; }
            ComPtr<IShellItem> item; LPWSTR result = nullptr;
            if (SUCCEEDED(status)) status = dialog->GetResult(&item); if (SUCCEEDED(status)) status = item->GetDisplayName(SIGDN_FILESYSPATH, &result);
            if (FAILED(status) || !result) { failure(requestId, "Save destination unavailable", status); return; }
            reply(requestId, "\"ok\":true,\"canceled\":false,\"filePath\":" + quote(utf8(result))); CoTaskMemFree(result); return;
        }
        if (operation == "window" && fields.size() == 3) {
            const auto& action = fields[2];
            if (action == "minimize") ShowWindow(mainWindow, SW_MINIMIZE);
            else if (action == "maximize") ShowWindow(mainWindow, SW_MAXIMIZE);
            else if (action == "restore") ShowWindow(mainWindow, SW_RESTORE);
            else if (action == "focus") SetForegroundWindow(mainWindow);
            else if (action == "top" || action == "normal") SetWindowPos(mainWindow, action == "top" ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            else throw std::runtime_error("Unsupported window action");
            layout(); snapshot(requestId); return;
        }
        if ((operation == "popup-deny" && fields.size() == 3) || (operation == "popup-bind" && fields.size() == 4)) {
            const auto found = pendingPopups.find(fields[2]); if (found == pendingPopups.end()) throw std::runtime_error("Unknown pending popup");
            if (operation == "popup-bind") {
                const auto* target = findTab(fields[3]); if (!target || !target->view) throw std::runtime_error("Popup target unavailable");
                const HRESULT status = found->second.args->put_NewWindow(target->view.Get());
                if (FAILED(status)) { failure(requestId, "Popup binding failed", status); return; }
            }
            found->second.deferral->Complete(); pendingPopups.erase(found); reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "visible" && fields.size() == 3) {
            ShowWindow(mainWindow, flag(fields[2]) ? (IsIconic(mainWindow) ? SW_RESTORE : SW_SHOWNOACTIVATE) : SW_HIDE);
            layout();
            for (const auto& tab : tabs) if (tab->controller) tab->controller->NotifyParentWindowPositionChanged();
            reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "resize" && fields.size() == 4) {
            const int width = std::stoi(fields[2]), height = std::stoi(fields[3]);
            if (width < 400 || height < 360 || width > 4096 || height > 2160) throw std::runtime_error("Invalid window size");
            SetWindowPos(mainWindow, nullptr, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            layout(); reply(requestId, "\"ok\":true"); return;
        }
        if (operation == "quit" && fields.size() == 2) {
            if (std::any_of(tabs.begin(), tabs.end(), [](const auto& tab) { return tab->leased; })) throw std::runtime_error("Active turn leases must be ended before shutdown");
            reply(requestId, "\"ok\":true"); DestroyWindow(mainWindow); return;
        }
        if (fields.size() < 3) throw std::runtime_error("Missing tab identity");
        auto* tab = findTab(fields[2]); if (!tab) throw std::runtime_error("Unknown tab");
        if (operation == "select" && fields.size() == 3) selectTab(tab->id);
        else if (operation == "bounds" && fields.size() == 8) {
            const auto scale = static_cast<double>(GetDpiForWindow(mainWindow)) / 96;
            const int x = std::stoi(fields[3]), y = std::stoi(fields[4]), width = std::stoi(fields[5]), height = std::stoi(fields[6]);
            if (x < -32768 || y < -32768 || x > 16384 || y > 16384 || width < 1 || height < 1 || width > 16384 || height > 16384) throw std::runtime_error("Invalid browser bounds");
            const auto left = static_cast<LONG>(std::round(x * scale)), top = static_cast<LONG>(std::round(y * scale));
            tab->requestedBounds = {left, top, left + static_cast<LONG>(std::floor(width * scale)), top + static_cast<LONG>(std::floor(height * scale))};
            tab->customBounds = true; tab->visible = flag(fields[7]); layout();
        }
        else if (operation == "lease" && fields.size() == 4) { tab->leased = flag(fields[3]); layout(); }
        else if (operation == "navigate" && fields.size() == 4) {
            const auto url = decodedUrl(fields[3]); const HRESULT status = tab->view->Navigate(url.c_str());
            if (FAILED(status)) { failure(requestId, "Navigation failed to start", status); return; }
        }
        else if (operation == "zoom" && fields.size() == 4) {
            const double zoom = std::stod(fields[3]); if (!std::isfinite(zoom) || zoom < 0.25 || zoom > 5) throw std::runtime_error("Invalid zoom factor");
            if (FAILED(tab->controller->put_ZoomFactor(zoom))) throw std::runtime_error("Zoom update failed");
        }
        else if (operation == "clear" && fields.size() == 3) {
            ComPtr<ICoreWebView2_13> core; ComPtr<ICoreWebView2Profile> profile; ComPtr<ICoreWebView2Profile2> cleaner;
            HRESULT status = tab->view.As(&core); if (SUCCEEDED(status)) status = core->get_Profile(&profile); if (SUCCEEDED(status)) status = profile.As(&cleaner);
            if (SUCCEEDED(status)) status = cleaner->ClearBrowsingDataAll(Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>([requestId](HRESULT result) -> HRESULT {
                if (FAILED(result)) failure(requestId, "Profile cleanup failed", result); else reply(requestId, "\"ok\":true"); return S_OK;
            }).Get());
            if (FAILED(status)) failure(requestId, "Profile cleanup unavailable", status); return;
        }
        else if (operation == "action" && fields.size() == 4) {
            HRESULT status = E_FAIL;
            if (fields[3] == "reload") status = tab->view->Reload();
            else if (fields[3] == "back") status = tab->view->GoBack();
            else if (fields[3] == "forward") status = tab->view->GoForward();
            else if (fields[3] == "stop") status = tab->view->Stop();
            else if (fields[3] == "focus") status = tab->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            if (FAILED(status)) { failure(requestId, "Browser action failed", status); return; }
        }
        else if (operation == "cdp" && fields.size() == 5) {
            const auto method = decodedText(fields[3], 128), parameters = decodedText(fields[4]);
            const HRESULT status = tab->view->CallDevToolsProtocolMethod(method.c_str(), parameters.c_str(), Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>([requestId](HRESULT result, LPCWSTR json) -> HRESULT {
                if (FAILED(result) || !json) failure(requestId, "Native CDP operation failed", result);
                else reply(requestId, "\"ok\":true,\"result\":" + utf8(json)); return S_OK;
            }).Get());
            if (FAILED(status)) failure(requestId, "Native CDP operation could not start", status); return;
        }
        else if (operation == "subscribe" && fields.size() == 4) {
            const auto method = decodedText(fields[3], 128); Tab::Subscription subscription;
            HRESULT status = tab->view->GetDevToolsProtocolEventReceiver(method.c_str(), &subscription.receiver);
            if (SUCCEEDED(status)) status = subscription.receiver->add_DevToolsProtocolEventReceived(Callback<ICoreWebView2DevToolsProtocolEventReceivedEventHandler>([id = tab->id, method](ICoreWebView2*, ICoreWebView2DevToolsProtocolEventReceivedEventArgs* args) -> HRESULT {
                LPWSTR json = nullptr; args->get_ParameterObjectAsJson(&json);
                if (json && wcslen(json) <= 1048576) emit("{\"event\":\"cdp-event\",\"tabId\":" + quote(id) + ",\"method\":" + quote(utf8(method)) + ",\"value\":" + utf8(json) + "}");
                if (json) CoTaskMemFree(json); return S_OK;
            }).Get(), &subscription.token);
            if (FAILED(status)) { failure(requestId, "Native CDP event subscription failed", status); return; }
            tab->subscriptions.push_back(std::move(subscription));
        }
        else if (operation == "close" && fields.size() == 3) { if (tab->leased) throw std::runtime_error("Active turn tab cannot be closed"); removeTab(tab->id); }
        else throw std::runtime_error("Unknown command or argument shape");
        reply(requestId, "\"ok\":true");
    } catch (const std::exception& error) { failure(requestId, error.what()); }
}

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_SIZE:
    case WM_MOVE:
        layout();
        for (const auto& tab : tabs) if (tab->controller) tab->controller->NotifyParentWindowPositionChanged();
        return 0;
    case WM_NOTIFY:
        if (reinterpret_cast<NMHDR*>(lParam)->hwndFrom == tabStrip && reinterpret_cast<NMHDR*>(lParam)->code == TCN_SELCHANGE) {
            const int selected = TabCtrl_GetCurSel(tabStrip);
            if (selected >= 0 && static_cast<std::size_t>(selected) < tabs.size()) selectTab(tabs[selected]->id);
        }
        return 0;
    case commandMessage: {
        std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(lParam));
        command(*line); return 0;
    }
    case backendExitMessage:
        // Preserve leased documents after a backend crash for diagnosis. This is not
        // an acceptance/ACK bypass; recovery must first record and end their owners.
        if (std::none_of(tabs.begin(), tabs.end(), [](const auto& tab) { return tab->leased; })) DestroyWindow(window);
        else SetWindowTextW(window, L"Codex Web GPT - backend stopped; recovery required"); return 0;
    case trayMessage:
        if (LOWORD(lParam) == WM_LBUTTONUP || LOWORD(lParam) == WM_LBUTTONDBLCLK) {
            ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
            SetForegroundWindow(window); layout();
            for (const auto& tab : tabs) if (tab->controller) tab->controller->NotifyParentWindowPositionChanged();
        } else if (LOWORD(lParam) == WM_RBUTTONUP || LOWORD(lParam) == WM_CONTEXTMENU) {
            HMENU menu = CreatePopupMenu();
            AppendMenuW(menu, MF_STRING, 201, trayOpen.c_str()); AppendMenuW(menu, MF_STRING, 202, trayQuit.c_str());
            POINT point{}; GetCursorPos(&point); SetForegroundWindow(window);
            const int selected = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, window, nullptr);
            DestroyMenu(menu);
            if (selected == 201) { ShowWindow(window, SW_RESTORE); layout(); }
            if (selected == 202) { if (applicationMode) emit("{\"event\":\"quit-requested\"}"); else command("quit\t0"); }
        }
        return 0;
    case WM_COMMAND:
        if (LOWORD(wParam) == 101) {
            static unsigned long manualId = 0;
            const auto* current = findTab(selectedTab);
            createTab(0, "manual" + std::to_string(++manualId), current ? current->profile : "default", L"https://chatgpt.com/", false, true);
        } else if (LOWORD(wParam) == 102) {
            auto* current = findTab(selectedTab);
            if (current && current->view && !current->leased) {
                const int length = GetWindowTextLengthW(addressBox);
                std::wstring url(static_cast<std::size_t>(length) + 1, L'\0');
                GetWindowTextW(addressBox, url.data(), length + 1); url.resize(length);
                if (url.rfind(L"https://", 0) == 0 || url.rfind(L"http://", 0) == 0) current->view->Navigate(url.c_str());
            }
        }
        return 0;
    case WM_CLOSE:
        // Closing the window is a tray action, not destruction of an in-flight browser document.
        if (applicationMode) emit("{\"event\":\"close-requested\"}");
        else { ShowWindow(window, SW_HIDE); layout(); } return 0;
    case WM_DESTROY:
        shuttingDown = true;
        for (auto& entry : pendingPopups) entry.second.deferral->Complete(); pendingPopups.clear();
        while (!tabs.empty()) removeTab(tabs.back()->id);
        Shell_NotifyIconW(NIM_DELETE, &tray);
        environment.Reset();
        PostQuitMessage(0); return 0;
    default: return DefWindowProcW(window, message, wParam, lParam);
    }
}

void readCommands() {
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (!input || input == INVALID_HANDLE_VALUE) return;
    char buffer[4096]; DWORD count = 0; std::string pending;
    while (!shuttingDown && ReadFile(input, buffer, sizeof(buffer), &count, nullptr) && count) {
        pending.append(buffer, count);
        if (pending.size() > 4 * 1024 * 1024) { emit("{\"event\":\"control-input-too-large\"}"); return; }
        std::size_t newline = 0;
        while ((newline = pending.find('\n')) != std::string::npos) {
            auto* line = new std::string(pending.substr(0, newline)); pending.erase(0, newline + 1);
            if (!line->empty() && line->back() == '\r') line->pop_back();
            if (shuttingDown || !PostMessageW(mainWindow, commandMessage, 0, reinterpret_cast<LPARAM>(line))) delete line;
        }
    }
    if (!shuttingDown) emit("{\"event\":\"control-closed\"}");
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
    std::wstring userDataFolder;
    bool hidden = false, noHome = false, offline = false; controlledMode = false;
    int argc = 0; LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    try {
        for (int index = 1; index < argc; ++index) {
            const std::wstring argument = argv[index];
            if (argument == L"--hidden") hidden = true;
            else if (argument == L"--controlled" || argument == L"--standalone") controlledMode = true;
            else if (argument == L"--offline") offline = true;
            else if (argument == L"--no-home") noHome = true;
            else if (argument == L"--user-data-folder" && index + 1 < argc) userDataFolder = argv[++index];
            else if (argument == L"--debug-port" && index + 1 < argc) debugPort = std::stoi(argv[++index]);
            else throw std::runtime_error("Unknown native host argument");
        }
        if (userDataFolder.empty()) {
            wchar_t local[MAX_PATH]{};
            if (!GetEnvironmentVariableW(L"APPDATA", local, MAX_PATH)) throw std::runtime_error("Application data folder unavailable");
            userDataFolder = std::wstring(local) + L"\\Codex Web GPT\\native-webview2";
        }
        if (debugPort < 0 || debugPort > 65535) throw std::runtime_error("Invalid CDP port");
        std::filesystem::create_directories(userDataFolder);
        userDataFolder = std::filesystem::weakly_canonical(userDataFolder).wstring();
    } catch (const std::exception& error) { if (argv) LocalFree(argv); failure(0, error.what()); return 1; }
    if (argv) LocalFree(argv);
    std::uint64_t key = 1469598103934665603ULL;
    for (const auto value : userDataFolder) { key ^= static_cast<std::uint16_t>(towlower(value)); key *= 1099511628211ULL; }
    const auto mutexName = L"Local\\CodexWebGPTNative-" + std::to_wstring(key);
    const HANDLE instanceLock = CreateMutexW(nullptr, TRUE, mutexName.c_str());
    if (!instanceLock || GetLastError() == ERROR_ALREADY_EXISTS) { if (instanceLock) CloseHandle(instanceLock); failure(0, "This native profile host is already running"); return 1; }
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) { CloseHandle(instanceLock); return 1; }
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_TAB_CLASSES}; InitCommonControlsEx(&controls);
    WNDCLASSW windowClass{}; windowClass.lpfnWndProc = windowProcedure; windowClass.hInstance = instance;
    windowClass.lpszClassName = L"CodexWebGPTNativeHost"; windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION); windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    RegisterClassW(&windowClass);
    mainWindow = CreateWindowExW(0, windowClass.lpszClassName, L"Codex Web GPT", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1120, 800, nullptr, nullptr, instance, nullptr);
    if (!mainWindow) { CoUninitialize(); ReleaseMutex(instanceLock); CloseHandle(instanceLock); return 1; }
    if (!controlledMode) {
        noHome = true;
        try { if (!debugPort) debugPort = availablePort(); startBackend(userDataFolder, hidden, offline); }
        catch (const std::exception& error) { failure(0, error.what()); DestroyWindow(mainWindow); CoUninitialize(); ReleaseMutex(instanceLock); CloseHandle(instanceLock); return 1; }
    }
    newButton = CreateWindowW(L"BUTTON", L"새 탭", WS_CHILD | WS_VISIBLE, 5, 5, 64, 25, mainWindow, reinterpret_cast<HMENU>(101), instance, nullptr);
    addressBox = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 76, 5, 940, 25, mainWindow, nullptr, instance, nullptr);
    goButton = CreateWindowW(L"BUTTON", L"이동", WS_CHILD | WS_VISIBLE, 1030, 5, 64, 25, mainWindow, reinterpret_cast<HMENU>(102), instance, nullptr);
    tabStrip = CreateWindowW(WC_TABCONTROLW, L"", WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS, 0, toolbarHeight, 1100, tabHeight, mainWindow, nullptr, instance, nullptr);
    tray.cbSize = sizeof(tray); tray.hWnd = mainWindow; tray.uID = 1; tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    tray.uCallbackMessage = trayMessage; tray.hIcon = windowClass.hIcon; wcscpy_s(tray.szTip, L"Codex Web GPT");
    Shell_NotifyIconW(NIM_ADD, &tray);
    if (!hidden) ShowWindow(mainWindow, SW_SHOW);
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    const auto arguments = L"--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + std::to_wstring(debugPort)
        + L" --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
    options->put_AdditionalBrowserArguments(arguments.c_str());
    const HRESULT initialization = CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataFolder.c_str(), options.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([noHome](HRESULT result, ICoreWebView2Environment* created) -> HRESULT {
            if (FAILED(result) || !created) { failure(0, "WebView2 environment initialization failed", result); DestroyWindow(mainWindow); return S_OK; }
            environment = created;
            LPWSTR version = nullptr; created->get_BrowserVersionString(&version);
            emit("{\"event\":\"ready\",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"debugPort\":" + std::to_string(debugPort)
                + ",\"runtimeVersion\":" + quote(version ? utf8(version) : "") + "}");
            if (version) CoTaskMemFree(version);
            if (!noHome) createTab(0, "home", "default", L"https://chatgpt.com/", false, true);
            return S_OK;
        }).Get());
    if (FAILED(initialization)) { failure(0, "WebView2 environment could not start", initialization); DestroyWindow(mainWindow); }
    std::thread(readCommands).detach();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    while (PeekMessageW(&message, nullptr, commandMessage, commandMessage, PM_REMOVE)) delete reinterpret_cast<std::string*>(message.lParam);
    if (backendProcess) { WaitForSingleObject(backendProcess, 2000); CloseHandle(backendProcess); }
    CoUninitialize(); ReleaseMutex(instanceLock); CloseHandle(instanceLock);
    return 0;
}

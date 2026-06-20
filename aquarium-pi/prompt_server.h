/*
 * HTTP prompt server for aquarium-pi — allows Claude Code hooks to display
 * confirmation dialogs on the device and get user input back.
 *
 * Usage:
 *   promptServerStart(8888);  // starts background thread listening on :8888
 *
 * API:
 *   POST /prompt
 *   Content-Type: application/json
 *   { "question": "Allow this action?", "options": ["yes", "no"] }
 *   → returns { "selected": "yes" }
 *
 * Rendering + input live in the renderer (main.cpp): drawPromptDialog() draws the box,
 * promptDialogHitTest()+promptServerCommit() handle taps, promptServerHandleKey() handles
 * arrow/Enter navigation. This header owns the HTTP server, shared state, and the blocking
 * request handler that waits for the user's answer.
 */

#pragma once
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <SDL2/SDL.h>

struct PromptState {
    std::string question;
    std::vector<std::string> options;
    int selectedIdx = -1;  // -1 = not selected, 0..n = option index
    bool active = false;   // true if dialog should be shown
    std::string lastSelected;  // return value for the HTTP response
};

static PromptState gPromptState;
static std::mutex gPromptMutex;

// Simple JSON parser for { "question": "...", "options": [...] }
static bool parsePromptJson(const std::string& body, PromptState& state) {
    // Very basic: look for "question":"...", "options":[...].
    // Not a full JSON parser, but sufficient for this use case.
    size_t qPos = body.find("\"question\"");
    size_t oPos = body.find("\"options\"");
    if (qPos == std::string::npos || oPos == std::string::npos) return false;

    // Extract question (between the first and second quote after "question":)
    size_t qStart = body.find(':', qPos) + 1;
    qStart = body.find('"', qStart) + 1;
    size_t qEnd = body.find('"', qStart);
    state.question = body.substr(qStart, qEnd - qStart);

    // Extract options array (simple split by ",")
    size_t aStart = body.find('[', oPos) + 1;
    size_t aEnd = body.find(']', aStart);
    std::string optStr = body.substr(aStart, aEnd - aStart);

    state.options.clear();
    size_t pos = 0;
    while (pos < optStr.size()) {
        size_t oStart = optStr.find('"', pos);
        if (oStart == std::string::npos) break;
        size_t oEnd = optStr.find('"', oStart + 1);
        if (oEnd == std::string::npos) break;
        state.options.push_back(optStr.substr(oStart + 1, oEnd - oStart - 1));
        pos = oEnd + 1;
    }
    return state.options.size() > 0;
}

// Handle a simple HTTP request
static std::string handlePromptRequest(const std::string& method, const std::string& path, const std::string& body) {
    if (method != "POST" || path != "/prompt") {
        return "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot found";
    }

    PromptState newState;
    if (!parsePromptJson(body, newState)) {
        return "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\n\r\nBad request";
    }

    {
        std::lock_guard<std::mutex> lock(gPromptMutex);
        gPromptState = newState;
        gPromptState.active = true;
        gPromptState.selectedIdx = 0;  // default to first option
    }

    // Busy-wait for selection (with timeout)
    int timeoutMs = 120000;  // 2 minutes
    int elapsedMs = 0;
    while (elapsedMs < timeoutMs) {
        {
            std::lock_guard<std::mutex> lock(gPromptMutex);
            if (!gPromptState.active) {
                // User made a selection
                std::string respBody = "{\"selected\":\"" + gPromptState.lastSelected + "\"}";
                std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n";
                resp += "Content-Length: " + std::to_string(respBody.size()) + "\r\n\r\n" + respBody;
                return resp;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        elapsedMs += 100;
    }

    // Timeout
    {
        std::lock_guard<std::mutex> lock(gPromptMutex);
        gPromptState.active = false;
    }
    return "HTTP/1.1 408 Request Timeout\r\nContent-Length: 7\r\n\r\nTimeout";
}

// Background HTTP server thread
static void promptServerThread(int port) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) return;

    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    // Bind to all interfaces so Claude Code on another machine (the dev box) can reach
    // the Pi over the LAN. The aquarium is a trusted home device; there's no auth.
    addr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(sock);
        return;
    }
    listen(sock, 1);

    while (true) {
        struct sockaddr_in client = {};
        socklen_t clen = sizeof(client);
        int csock = accept(sock, (struct sockaddr*)&client, &clen);
        if (csock < 0) continue;

        char buf[8192] = {};
        int n = recv(csock, buf, sizeof(buf) - 1, 0);
        if (n <= 0) { close(csock); continue; }

        // Parse HTTP request (naive)
        std::string req(buf, n);
        std::string method, path, body;
        size_t space1 = req.find(' ');
        size_t space2 = req.find(' ', space1 + 1);
        if (space1 != std::string::npos && space2 != std::string::npos) {
            method = req.substr(0, space1);
            path = req.substr(space1 + 1, space2 - space1 - 1);
            size_t bodyStart = req.find("\r\n\r\n");
            if (bodyStart != std::string::npos) body = req.substr(bodyStart + 4);
        }

        std::string resp = handlePromptRequest(method, path, body);
        send(csock, resp.c_str(), resp.size(), 0);
        close(csock);
    }
}

// Start the prompt server in a background thread
static void promptServerStart(int port = 8888) {
    std::thread t(promptServerThread, port);
    t.detach();
}

// Number of options in the active prompt (0 if none). Used by the renderer's hit-test.
static int promptServerOptionCount() {
    std::lock_guard<std::mutex> lock(gPromptMutex);
    return gPromptState.active ? (int)gPromptState.options.size() : 0;
}

// Commit a selection by option index — wakes the blocked HTTP handler with the answer.
// The dialog geometry (and thus mouse hit-testing) lives in the renderer (main.cpp),
// which calls this once it resolves a click to an option.
static void promptServerCommit(int idx) {
    std::lock_guard<std::mutex> lock(gPromptMutex);
    if (!gPromptState.active) return;
    if (idx < 0 || idx >= (int)gPromptState.options.size()) return;
    gPromptState.selectedIdx = idx;
    gPromptState.lastSelected = gPromptState.options[idx];
    gPromptState.active = false;
}

// Check if a prompt is currently active
static bool promptServerIsActive() {
    std::lock_guard<std::mutex> lock(gPromptMutex);
    return gPromptState.active;
}

// Handle keyboard input (arrow keys for navigation, Enter for selection)
static void promptServerHandleKey(int key) {
    std::lock_guard<std::mutex> lock(gPromptMutex);
    if (!gPromptState.active) return;

    if (key == SDLK_LEFT && gPromptState.selectedIdx > 0) {
        gPromptState.selectedIdx--;
    } else if (key == SDLK_RIGHT && gPromptState.selectedIdx < (int)gPromptState.options.size() - 1) {
        gPromptState.selectedIdx++;
    } else if (key == SDLK_RETURN && gPromptState.selectedIdx >= 0) {
        gPromptState.lastSelected = gPromptState.options[gPromptState.selectedIdx];
        gPromptState.active = false;
    }
}

#pragma once
// SDL2 canvas shim matching the LovyanGFX sprite API used by aquarium.ino.
// Requires: SDL2, SDL2_gfx, SDL2_ttf
#include <SDL2/SDL.h>
#include <SDL2/SDL2_gfxPrimitives.h>
#include <SDL2/SDL_ttf.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

static inline void _colRGB(uint32_t c, uint8_t& r, uint8_t& g, uint8_t& b) {
    r = (c >> 16) & 0xFF;
    g = (c >>  8) & 0xFF;
    b =  c        & 0xFF;
}

// ─── Display ──────────────────────────────────────────────────────────────────
class Display {
public:
    SDL_Window*   window   = nullptr;
    SDL_Renderer* renderer = nullptr;
    bool     _touched = false;
    int      _touchX  = 0, _touchY = 0;

    bool init() {
        if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) < 0) {
            printf("SDL_Init failed: %s\n", SDL_GetError());
            return false;
        }
        if (TTF_Init() < 0) {
            printf("TTF_Init failed: %s\n", TTF_GetError());
            return false;
        }
        window = SDL_CreateWindow("Desktop Aquarium",
            SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
            800, 480, SDL_WINDOW_SHOWN);
        if (!window) { printf("SDL_CreateWindow: %s\n", SDL_GetError()); return false; }

        renderer = SDL_CreateRenderer(window, -1,
            SDL_RENDERER_ACCELERATED | SDL_RENDERER_TARGETTEXTURE);
        if (!renderer) { printf("SDL_CreateRenderer: %s\n", SDL_GetError()); return false; }

        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_NONE);
        return true;
    }

    int  width()  const { return 800; }
    int  height() const { return 480; }
    void setRotation(int)    {}
    void setBrightness(int)  {}

    void fillScreen(uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        SDL_SetRenderDrawColor(renderer, r, g, b, 255);
        SDL_RenderClear(renderer);
        SDL_RenderPresent(renderer);
    }

    bool getTouch(uint16_t* tx, uint16_t* ty) const {
        if (_touched) { *tx = (uint16_t)_touchX; *ty = (uint16_t)_touchY; }
        return _touched;
    }
};

// ─── Canvas (sprite) ──────────────────────────────────────────────────────────
class Canvas {
    Display*      _disp    = nullptr;
    SDL_Texture*  _tex     = nullptr;
    int           _w = 0,  _h = 0;
    uint32_t      _textCol  = 0xFFFFFF;
    int           _textSize = 1;
    int           _curX = 0, _curY = 0;

    // fonts[1..4] for textSize 1–4
    TTF_Font* _fonts[5] = {};

    // Base TTF point size at textSize=1. Scaled ×textSize for larger sizes.
    static constexpr int BASE_PT = 9;

    SDL_Renderer* rend() const { return _disp->renderer; }

    TTF_Font* curFont() const {
        int s = (_textSize < 1) ? 1 : (_textSize > 4 ? 4 : _textSize);
        return _fonts[s];
    }

public:
    // Character width at textSize=1 (measured from font after createSprite).
    // Used by main.cpp to position fish text (replaces the hard-coded 6).
    int charW = 6;
    int charH = 9;

    explicit Canvas(Display* d) : _disp(d) {}

    ~Canvas() {
        for (int i = 1; i <= 4; i++) { if (_fonts[i]) TTF_CloseFont(_fonts[i]); }
        if (_tex) SDL_DestroyTexture(_tex);
    }

    void setPsram(bool) {}

    bool createSprite(int w, int h) {
        _w = w; _h = h;
        _tex = SDL_CreateTexture(rend(), SDL_PIXELFORMAT_RGB888,
                                 SDL_TEXTUREACCESS_TARGET, w, h);
        if (!_tex) {
            printf("Canvas: SDL_CreateTexture failed: %s\n", SDL_GetError());
            return false;
        }

        // Try common monospace fonts on Raspberry Pi OS
        static const char* kFontPaths[] = {
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
            "/usr/share/fonts/truetype/ttf-bitstream-vera/VeraMono.ttf",
            nullptr
        };

        for (int s = 1; s <= 4; s++) {
            for (int fi = 0; kFontPaths[fi]; fi++) {
                _fonts[s] = TTF_OpenFont(kFontPaths[fi], BASE_PT * s);
                if (_fonts[s]) {
                    TTF_SetFontHinting(_fonts[s], TTF_HINTING_MONO);
                    break;
                }
            }
            if (!_fonts[s]) printf("Canvas: no font found at size %d\n", s);
        }

        // Measure character dimensions from font at size 1
        if (_fonts[1]) {
            int minx, maxx, miny, maxy, advance;
            if (TTF_GlyphMetrics(_fonts[1], 'A', &minx, &maxx, &miny, &maxy, &advance) == 0 && advance > 0)
                charW = advance;
            charH = TTF_FontHeight(_fonts[1]);
        }

        // Set sprite as the active render target for all subsequent draw calls
        SDL_SetRenderTarget(rend(), _tex);
        return true;
    }

    // Blit sprite to the window and present, then restore sprite as target.
    void pushSprite(int x, int y) {
        SDL_SetRenderTarget(rend(), nullptr);
        SDL_Rect dst = { x, y, _w, _h };
        SDL_RenderCopy(rend(), _tex, nullptr, &dst);
        SDL_RenderPresent(rend());
        SDL_SetRenderTarget(rend(), _tex);
    }

    // ── Draw primitives ────────────────────────────────────────────────────────

    void fillRect(int x, int y, int w, int h, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        boxRGBA(rend(), (Sint16)x, (Sint16)y,
                (Sint16)(x + w - 1), (Sint16)(y + h - 1), r, g, b, 255);
    }

    void drawRect(int x, int y, int w, int h, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        rectangleRGBA(rend(), (Sint16)x, (Sint16)y,
                      (Sint16)(x + w - 1), (Sint16)(y + h - 1), r, g, b, 255);
    }

    void fillCircle(int cx, int cy, int radius, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        filledCircleRGBA(rend(), (Sint16)cx, (Sint16)cy, (Sint16)radius, r, g, b, 255);
    }

    void drawCircle(int cx, int cy, int radius, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        circleRGBA(rend(), (Sint16)cx, (Sint16)cy, (Sint16)radius, r, g, b, 255);
    }

    void fillEllipse(int cx, int cy, int rx, int ry, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        filledEllipseRGBA(rend(), (Sint16)cx, (Sint16)cy, (Sint16)rx, (Sint16)ry, r, g, b, 255);
    }

    void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        filledTrigonRGBA(rend(), (Sint16)x0, (Sint16)y0,
                         (Sint16)x1, (Sint16)y1, (Sint16)x2, (Sint16)y2, r, g, b, 255);
    }

    void drawLine(int x0, int y0, int x1, int y1, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        lineRGBA(rend(), (Sint16)x0, (Sint16)y0, (Sint16)x1, (Sint16)y1, r, g, b, 255);
    }

    void drawFastVLine(int x, int y, int h, uint32_t col) {
        drawLine(x, y, x, y + h - 1, col);
    }

    void drawFastHLine(int x, int y, int w, uint32_t col) {
        drawLine(x, y, x + w - 1, y, col);
    }

    void drawPixel(int x, int y, uint32_t col) {
        uint8_t r, g, b; _colRGB(col, r, g, b);
        pixelRGBA(rend(), (Sint16)x, (Sint16)y, r, g, b, 255);
    }

    // ── Text ───────────────────────────────────────────────────────────────────

    void setTextSize(int s)       { _textSize = (s < 1) ? 1 : (s > 4 ? 4 : s); }
    void setTextColor(uint32_t c) { _textCol = c; }
    void setCursor(int x, int y)  { _curX = x; _curY = y; }

    void print(const char* s) {
        if (!s || !*s) return;
        TTF_Font* fnt = curFont();
        if (!fnt) return;
        uint8_t r, g, b; _colRGB(_textCol, r, g, b);
        SDL_Color col = { r, g, b, 255 };
        SDL_Surface* surf = TTF_RenderText_Solid(fnt, s, col);
        if (!surf) return;
        SDL_Texture* tex = SDL_CreateTextureFromSurface(rend(), surf);
        if (tex) {
            SDL_SetTextureBlendMode(tex, SDL_BLENDMODE_BLEND);
            SDL_Rect dst = { _curX, _curY, surf->w, surf->h };
            SDL_RenderCopy(rend(), tex, nullptr, &dst);
            _curX += surf->w;
            SDL_DestroyTexture(tex);
        }
        SDL_FreeSurface(surf);
    }

    void print(char c) { char s[2] = { c, '\0' }; print(s); }
};

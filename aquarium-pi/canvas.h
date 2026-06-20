#pragma once
// SDL2 canvas shim matching the LovyanGFX sprite API used by aquarium.ino.
// Requires: SDL2, SDL2_gfx, SDL2_ttf
#include <SDL2/SDL.h>
#include <SDL2/SDL2_gfxPrimitives.h>
#include <SDL2/SDL_ttf.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#ifdef __linux__
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#endif

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
    int      _brightness = 255;
#ifdef __linux__
    char     _blBrightnessPath[128] = {};
    int      _blMax = 255;
    bool     _blProbed = false;

    // Discover /sys/class/backlight once, on first brightness change (not during init).
    void _probeBacklight() {
        if (_blProbed) return;
        _blProbed = true;
        const char* force = getenv("AQUARIUM_BRIGHTNESS_SYSFS");
        if (force && force[0] == '0') return;

        DIR* dir = opendir("/sys/class/backlight");
        if (!dir) return;
        struct dirent* ent;
        while ((ent = readdir(dir)) != nullptr) {
            if (ent->d_name[0] == '.') continue;
            char base[96];
            snprintf(base, sizeof(base), "/sys/class/backlight/%s", ent->d_name);
            snprintf(_blBrightnessPath, sizeof(_blBrightnessPath), "%s/brightness", base);
            char maxPath[112];
            snprintf(maxPath, sizeof(maxPath), "%s/max_brightness", base);
            int mfd = open(maxPath, O_RDONLY);
            if (mfd >= 0) {
                char mbuf[16] = {};
                if (read(mfd, mbuf, sizeof(mbuf) - 1) > 0)
                    _blMax = atoi(mbuf);
                close(mfd);
            }
            if (_blMax < 1) _blMax = 255;
            break;
        }
        closedir(dir);
    }

    void _writeSysfsBrightness(int b) {
        _probeBacklight();
        if (!_blBrightnessPath[0]) return;
        int scaled = (b * _blMax + 127) / 255;
        if (scaled < 1) scaled = 1;
        if (scaled > _blMax) scaled = _blMax;
        int fd = open(_blBrightnessPath, O_WRONLY);
        if (fd < 0) return;
        char buf[12];
        int n = snprintf(buf, sizeof(buf), "%d", scaled);
        if (n > 0) write(fd, buf, (size_t)n);
        close(fd);
    }
#endif

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

        // On the Pi Zero's legacy VideoCore IV GL driver the "accelerated"
        // path is often slower than pure software for this 2D primitive-heavy
        // workload (SDL2_gfx draws on the CPU regardless). Set
        // AQUARIUM_SOFTWARE=1 to A/B test the software renderer.
        Uint32 flags = getenv("AQUARIUM_SOFTWARE")
            ? SDL_RENDERER_SOFTWARE
            : SDL_RENDERER_ACCELERATED;
        renderer = SDL_CreateRenderer(window, -1, flags);
        if (!renderer) { printf("SDL_CreateRenderer: %s\n", SDL_GetError()); return false; }

        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_NONE);
        return true;
    }

    int  width()  const { return 800; }
    int  height() const { return 480; }
    void setRotation(int) {}
    int  brightness() const { return _brightness; }
    void setBrightness(int b) {
        if (b < 10) b = 10;
        if (b > 255) b = 255;
        _brightness = b;
        // Do not call SDL_SetWindowBrightness — on Raspberry Pi SDL builds it can
        // trap with SIGILL. Hardware backlight is optional via sysfs below.
#ifdef __linux__
        _writeSysfsBrightness(b);
#endif
    }

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
    int           _w = 0,  _h = 0;
    uint32_t      _textCol  = 0xFFFFFF;
    int           _textSize = 1;
    int           _curX = 0, _curY = 0;

    // fonts[1..4] for textSize 1–4
    TTF_Font* _fonts[5] = {};

    // ── Glyph cache ─────────────────────────────────────────────────────────
    // Per-frame TTF_RenderText_Solid + CreateTextureFromSurface + DestroyTexture
    // was the dominant cost (the fish ARE text, drawn ~17×/frame). Instead we
    // pre-render every printable ASCII glyph once, in white, per font size, then
    // blit cached textures with a per-draw colour mod.
    static constexpr int GLYPH_FIRST = 32;   // space
    static constexpr int GLYPH_LAST  = 126;  // '~'
    static constexpr int GLYPH_COUNT = GLYPH_LAST - GLYPH_FIRST + 1;
    SDL_Texture* _glyphs[5][GLYPH_COUNT] = {};   // [size][char-32]
    int          _glyphW[5][GLYPH_COUNT] = {};
    int          _glyphH[5][GLYPH_COUNT] = {};
    int          _advance[5] = {};               // monospace step per size

    // Base TTF point size at textSize=1. Scaled ×textSize for larger sizes.
    static constexpr int BASE_PT = 9;

    SDL_Renderer* rend() const { return _disp->renderer; }

    int clampSize() const {
        return (_textSize < 1) ? 1 : (_textSize > 4 ? 4 : _textSize);
    }

    // Render every printable glyph for one font size into the cache.
    void buildGlyphCache(int s) {
        TTF_Font* fnt = _fonts[s];
        if (!fnt) return;
        SDL_Color white = { 255, 255, 255, 255 };
        for (int i = 0; i < GLYPH_COUNT; i++) {
            char ch = (char)(GLYPH_FIRST + i);
            // Solid (not Blended) to match the original RenderText_Solid look.
            SDL_Surface* surf = TTF_RenderGlyph_Solid(fnt, (Uint16)ch, white);
            if (!surf) continue;
            SDL_Texture* tex = SDL_CreateTextureFromSurface(rend(), surf);
            if (tex) {
                SDL_SetTextureBlendMode(tex, SDL_BLENDMODE_BLEND);
                _glyphs[s][i] = tex;
                _glyphW[s][i] = surf->w;
                _glyphH[s][i] = surf->h;
            }
            SDL_FreeSurface(surf);
        }
        int minx, maxx, miny, maxy, adv;
        if (TTF_GlyphMetrics(fnt, 'A', &minx, &maxx, &miny, &maxy, &adv) == 0 && adv > 0)
            _advance[s] = adv;
        else
            _advance[s] = BASE_PT * s;  // sane fallback
    }

public:
    // Character width at textSize=1 (measured from font after createSprite).
    // Used by main.cpp to position fish text (replaces the hard-coded 6).
    int charW = 6;
    int charH = 9;

    explicit Canvas(Display* d) : _disp(d) {}

    ~Canvas() {
        for (int s = 1; s <= 4; s++) {
            for (int i = 0; i < GLYPH_COUNT; i++)
                if (_glyphs[s][i]) SDL_DestroyTexture(_glyphs[s][i]);
        }
        for (int i = 1; i <= 4; i++) { if (_fonts[i]) TTF_CloseFont(_fonts[i]); }
    }

    void setPsram(bool) {}

    bool createSprite(int w, int h) {
        _w = w; _h = h;
        // No offscreen target texture: SDL's renderer is already double-buffered
        // (Clear → draw → Present), so the LovyanGFX sprite-blit pattern just
        // added a redundant full-screen copy plus render-target switches every
        // frame — both slow on the Pi Zero. We draw straight to the backbuffer.

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

        // Pre-render all glyphs once per size.
        for (int s = 1; s <= 4; s++) buildGlyphCache(s);

        // Measure character dimensions from font at size 1
        if (_fonts[1]) {
            if (_advance[1] > 0) charW = _advance[1];
            charH = TTF_FontHeight(_fonts[1]);
        }
        return true;
    }

    // Present the finished frame. (x,y) retained for API compatibility with the
    // LovyanGFX sprite call site; we always draw full-screen to the backbuffer.
    void pushSprite(int /*x*/, int /*y*/) {
        SDL_RenderPresent(rend());
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
        int sz = clampSize();
        if (!_fonts[sz]) return;
        uint8_t r, g, b; _colRGB(_textCol, r, g, b);
        int adv = _advance[sz];
        for (const char* p = s; *p; ++p) {
            unsigned char ch = (unsigned char)*p;
            if (ch < GLYPH_FIRST || ch > GLYPH_LAST) { _curX += adv; continue; }
            int i = ch - GLYPH_FIRST;
            SDL_Texture* tex = _glyphs[sz][i];
            if (tex) {
                SDL_SetTextureColorMod(tex, r, g, b);
                SDL_Rect dst = { _curX, _curY, _glyphW[sz][i], _glyphH[sz][i] };
                SDL_RenderCopy(rend(), tex, nullptr, &dst);
            }
            _curX += adv;   // monospace step keeps fish/menu alignment intact
        }
    }

    void print(char c) { char s[2] = { c, '\0' }; print(s); }
};

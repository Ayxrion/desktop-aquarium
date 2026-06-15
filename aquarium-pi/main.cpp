/*
 * ASCII Aquarium — Raspberry Pi / SDL2 variant
 * Adapted from aquarium/aquarium.ino (ESP32-S3 / LovyanGFX).
 *
 * Changes from the ESP32 version:
 *   - LovyanGFX replaced by SDL2 canvas shim (canvas.h)
 *   - WiFi / OTA removed; weather uses libcurl (weather.h)
 *   - Day/night uses system localtime (daynight.h)
 *   - Arduino API shims in compat.h (millis, random, constrain, …)
 *   - setup() + loop() called from main(); SDL events drive input
 *   - Space bar drops food; Escape quits; left mouse / touch = tap
 *   - fishHW() uses canvas.charW instead of hard-coded 6
 */

#include <ctime>
#include <cstdlib>
#include "compat.h"
#include "canvas.h"
#include "weather.h"
#include "daynight.h"
#include "version.h"

// ─── Screen ──────────────────────────────────────────────────────────────────
#define SCREEN_W  800
#define SCREEN_H  480
#define TANK_TOP   72

static int16_t terrainY[SCREEN_W];

// ─── Button ──────────────────────────────────────────────────────────────────
#define BUTTON_PIN   -1
#define DEBOUNCE_MS  300

// ─── Timing ──────────────────────────────────────────────────────────────────
#define FRAME_MS  50

// ─── Weather sky strip ────────────────────────────────────────────────────────
#define WEATHER_SKY_H  TANK_TOP

uint32_t lastFrameMs = 0;
float    tick        = 0;

// ─── Colours (24-bit RGB) ────────────────────────────────────────────────────
#define COL_BG      0x003060UL
#define COL_SAND    0xC8A050UL
#define COL_BUBBLE  0x55CCFFUL
#define COL_WEED        0x00AA44UL
#define COL_WEED_LEAF   0x33DD66UL
#define COL_BG_PLANT    0x0D3318UL
#define COL_BG_LEAF     0x163D20UL

const uint32_t PAIR_COLS[8] = {
    0x00EE66UL, 0xFFDD00UL, 0xFF6600UL, 0xCC44FFUL,
    0x44DDFFUL, 0xFF44AAUL, 0x88FF44UL, 0xFFAA22UL,
};
const uint32_t SCHOOL_COLS[16] = {
    0x00FFFFUL, 0xFF66FFUL, 0xFF8800UL, 0x88FFDDUL,
    0xCCFF44UL, 0x22DDBBUL, 0xFFBB55UL, 0xBB88FFUL,
    0x44FFEEUL, 0xFF44CCUL, 0x99FF22UL, 0xFF9966UL,
    0x6688FFUL, 0xFFEE22UL, 0x22FFAAUL, 0xEE88FFUL,
};
const uint32_t SCHOOL2_COLS[20] = {
    0xFF4400UL, 0xFF9900UL, 0xFFCC00UL, 0xFF6688UL,
    0xDD2255UL, 0xFF88BBUL, 0xFFAAFFUL, 0xFFFF66UL,
    0x77FFAAUL, 0xCCAA88UL, 0xFF3300UL, 0xFFBB00UL,
    0xFF55AAUL, 0xEE1144UL, 0xFF99CCUL, 0xFFDD88UL,
    0x99FF77UL, 0xDDBB99UL, 0xFF6600UL, 0xFFCC55UL,
};
const uint32_t ANGEL_COLS[12] = {
    0xEEEEEEUL, 0xFFFFFFUL, 0xDDCCAAUL, 0xFFDD88UL,
    0xFFCC44UL, 0xBBDDFFUL, 0x99CCFFUL, 0xFFBBABUL,
    0xCCFFDDUL, 0xFFEECCUL, 0xAADDCCUL, 0xFFCCFFUL,
};
const uint32_t FLAKE_COLS[7] = {
    0xFF2020UL, 0xFF8800UL, 0xFFFF00UL, 0x00FF44UL,
    0x00AAFFUL, 0x9944FFUL, 0xFF00CCUL,
};

// ─── Bubbles ─────────────────────────────────────────────────────────────────
#define NUM_BUBBLES 20
struct Bubble { float x, y, spd; uint8_t r; };
Bubble bubbles[NUM_BUBBLES];

// ─── Background plants ────────────────────────────────────────────────────────
#define NUM_BG_PLANTS   12
#define BG_PLANT_SEG_H  15
struct BgPlant { uint16_t baseX; uint8_t segs; uint8_t type; };
BgPlant bgPlants[NUM_BG_PLANTS];

// ─── Foreground hornwort ──────────────────────────────────────────────────────
#define NUM_FG_HORNWORT  5
struct FgHornwort { uint16_t baseX; uint8_t segs; };
FgHornwort fgHornworts[NUM_FG_HORNWORT];

// ─── Seaweed ─────────────────────────────────────────────────────────────────
#define NUM_WEEDS     8
#define WEED_SEG_H   14
#define BRANCH_SEGS   3
struct Seaweed {
    uint16_t baseX; uint8_t segs; uint8_t numBranches;
    uint8_t branchAt[2]; int8_t branchSide[2];
};
Seaweed weeds[NUM_WEEDS];

// ─── Snail ───────────────────────────────────────────────────────────────────
struct Snail    { float x, spd; bool facingRight; };
static Snail    snail;

// ─── Starfish ────────────────────────────────────────────────────────────────
struct Starfish { float x, spd; bool facingRight; };
static Starfish starfish;

// ─── Boat ────────────────────────────────────────────────────────────────────
#define BOAT_W          76
#define BOAT_LAUNCH_MS  60000UL
struct Boat { float x; bool active; uint32_t lastLaunchMs; };
static Boat boat = { (float)(SCREEN_W + BOAT_W), false, 0UL };

// ─── Food flakes ─────────────────────────────────────────────────────────────
#define MAX_FLAKES 10
struct Flake { float x, y, spd; bool active; uint8_t shape; uint8_t colorIdx; };
Flake flakes[MAX_FLAKES];

// ─── Fish ────────────────────────────────────────────────────────────────────
enum FishType : uint8_t { FISH_PAIR, FISH_SCHOOL, FISH_SCHOOL2, FISH_ANGEL };
struct Fish {
    float   x, y, z, vx, vy, vz, tx, ty, tz, wanderCD;
    bool    facingRight;
    FishType type;
    int8_t  partner;
    bool    goingForFood;
    int8_t  targetFlake;
    bool    chasing;
    float   fullTimer;
};

#define MAX_PAIR    8
#define MAX_SCHOOL  16
#define MAX_SCHOOL2 20
#define MAX_ANGEL   12
#define MAX_FISH    (MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2 + MAX_ANGEL)

static int numPair    = 2;
static int numSchool  = 5;
static int numSchool2 = 7;
static int numAngel   = 3;

Fish fish[MAX_FISH];

// ─── Menu ─────────────────────────────────────────────────────────────────────
#define HBTN_X   748
#define HBTN_Y     5
#define HBTN_W    47
#define HBTN_H    38
#define MENU_X   510
#define MENU_Y    48
#define MENU_W   282
#define MENU_H   410

bool     lastBtnState  = HIGH;
uint32_t lastBtnMs     = 0;
bool     lastTouched   = false;
bool     menuOpen      = false;

int8_t   weatherOverrideIdx = -1;

// ─── Weather visuals ─────────────────────────────────────────────────────────
#define MAX_CLOUDS 5
struct Cloud { float x, y, w, h, spd; };
static Cloud clouds[MAX_CLOUDS];
static int   numClouds = 0;

#define MAX_RAINDROPS 120
struct RainDrop { float x, y, spd; };
static RainDrop rainDrops[MAX_RAINDROPS];

#define MAX_SNOWFLAKES 60
struct SnowFlake { float x, y, spd, sway; };
static SnowFlake snowFlakes[MAX_SNOWFLAKES];

static float   _lightningTimer = 0;
static uint8_t _lightningFlash = 0;
static float   _lightBoltX     = 400;

// ─── Stars ───────────────────────────────────────────────────────────────────
#define NUM_STARS 50
struct Star { uint16_t x; uint8_t y; uint8_t phase; };
static Star skyStars[NUM_STARS];

// ─── Display / canvas globals ─────────────────────────────────────────────────
static Display display;
static Canvas  canvas(&display);

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

float frand()                    { return random(0, 1000) * 0.001f; }
float frandr(float lo, float hi) { return lo + frand() * (hi - lo); }

inline bool isFishActive(int i) {
    if (i < MAX_PAIR)                                    return i < numPair;
    if (i < MAX_PAIR + MAX_SCHOOL)                       return (i - MAX_PAIR) < numSchool;
    if (i < MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2)         return (i - MAX_PAIR - MAX_SCHOOL) < numSchool2;
    return (i - MAX_PAIR - MAX_SCHOOL - MAX_SCHOOL2) < numAngel;
}

int projX(float x, float z) {
    const float cx = SCREEN_W * 0.5f;
    return (int)(cx + (x - cx) * (1.0f - z * 0.30f));
}
int projY(float y, float z) {
    const float cy = SCREEN_H * 0.45f;
    return (int)(cy + (y - cy) * (1.0f - z * 0.38f));
}

int fishTS(const Fish& f) {
    if (f.type == FISH_PAIR) return (f.z < 0.5f) ? 3 : 2;
    return (f.z < 0.6f) ? 2 : 1;
}

// Uses canvas.charW so fish text is correctly centred regardless of font metrics.
int fishHW(const Fish& f) {
    int ts    = fishTS(f);
    int chars = (f.type == FISH_PAIR) ? 5 : 3;
    return (chars * canvas.charW * ts) / 2;
}

uint32_t fishColor(int idx) {
    if (idx < MAX_PAIR)                              return PAIR_COLS[idx % 8];
    if (idx < MAX_PAIR + MAX_SCHOOL)                 return SCHOOL_COLS[(idx - MAX_PAIR) % 16];
    if (idx < MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2)   return SCHOOL2_COLS[(idx - MAX_PAIR - MAX_SCHOOL) % 20];
    return ANGEL_COLS[(idx - MAX_PAIR - MAX_SCHOOL - MAX_SCHOOL2) % MAX_ANGEL];
}

float boundAccel(float val, float lo, float hi, float k = 0.30f) {
    if (val < lo) return (lo - val) * k;
    if (val > hi) return (hi - val) * k;
    return 0.0f;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Init helpers
// ═══════════════════════════════════════════════════════════════════════════════

void resetBubble(int i, bool scatter) {
    bubbles[i].x   = frandr(5.0f, SCREEN_W - 5.0f);
    bubbles[i].y   = scatter ? frandr((float)TANK_TOP, (float)SCREEN_H) : (float)(SCREEN_H + 10);
    bubbles[i].spd = frandr(0.8f, 2.5f);
    bubbles[i].r   = (uint8_t)random(3, 9);
}

void initFishEntry(int idx, float x, float y, float z, float vx,
                   FishType type, int8_t partner) {
    Fish& f     = fish[idx];
    f.x = f.tx = x; f.y = f.ty = y; f.z = f.tz = z;
    f.vx = vx; f.vy = 0; f.vz = 0;
    f.wanderCD     = frandr(40, 130);
    f.facingRight  = (vx >= 0);
    f.type         = type;
    f.partner      = partner;
    f.goingForFood = false;
    f.targetFlake  = -1;
    f.chasing      = (random(0, 2) == 0);
    f.fullTimer    = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Add / remove fish
// ═══════════════════════════════════════════════════════════════════════════════

void addFish(FishType type) {
    if (type == FISH_PAIR && numPair < MAX_PAIR) {
        int idx = numPair;
        int8_t partner = -1;
        if (idx % 2 == 1) { partner = idx - 1; fish[idx - 1].partner = idx; }
        initFishEntry(idx,
            frandr(80, 720), frandr(80, 360), frandr(0.15f, 0.55f),
            frandr(-3.0f, 3.0f), FISH_PAIR, partner);
        numPair++;
    } else if (type == FISH_SCHOOL && numSchool < MAX_SCHOOL) {
        initFishEntry(MAX_PAIR + numSchool,
            frandr(200, 600), frandr(80, 340), frandr(0.30f, 0.70f),
            frandr(-2.0f, 2.0f), FISH_SCHOOL, -1);
        numSchool++;
    } else if (type == FISH_SCHOOL2 && numSchool2 < MAX_SCHOOL2) {
        initFishEntry(MAX_PAIR + MAX_SCHOOL + numSchool2,
            frandr(150, 650), frandr(100, 360), frandr(0.30f, 0.70f),
            frandr(-2.0f, 2.0f), FISH_SCHOOL2, -1);
        numSchool2++;
    } else if (type == FISH_ANGEL && numAngel < MAX_ANGEL) {
        initFishEntry(MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2 + numAngel,
            frandr(200, 600), frandr(90, 320), frandr(0.25f, 0.65f),
            frandr(-3.0f, 3.0f), FISH_ANGEL, -1);
        numAngel++;
    }
}

void removeFish(FishType type) {
    if (type == FISH_PAIR    && numPair    > 0) { int idx = numPair - 1; if (idx % 2 == 1) fish[idx - 1].partner = -1; numPair--;    }
    else if (type == FISH_SCHOOL  && numSchool  > 0) numSchool--;
    else if (type == FISH_SCHOOL2 && numSchool2 > 0) numSchool2--;
    else if (type == FISH_ANGEL   && numAngel   > 0) numAngel--;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Weather visual effects  (identical to ESP32 version)
// ═══════════════════════════════════════════════════════════════════════════════

void initWeatherEffects() {
    switch (currentWeather) {
        case WEATHER_PARTLY_CLOUDY: numClouds = 2; break;
        case WEATHER_CLOUDY:        numClouds = 4; break;
        case WEATHER_FOGGY:         numClouds = 5; break;
        case WEATHER_RAINY:         numClouds = 3; break;
        case WEATHER_STORMY:        numClouds = 4; break;
        default:                    numClouds = 0; break;
    }
    for (int i = 0; i < numClouds; i++) {
        clouds[i].x   = frandr(80, SCREEN_W - 80);
        clouds[i].y   = frandr(15, WEATHER_SKY_H - 25);
        clouds[i].w   = frandr(90, 160);
        clouds[i].h   = frandr(20, 30);
        clouds[i].spd = frandr(0.06f, 0.22f) * (random(0, 2) ? 1.0f : -1.0f);
    }
    for (int i = 0; i < MAX_RAINDROPS; i++) {
        rainDrops[i].x   = frandr(0, SCREEN_W);
        rainDrops[i].y   = frandr(0, WEATHER_SKY_H);
        rainDrops[i].spd = frandr(7.0f, 13.0f);
    }
    for (int i = 0; i < MAX_SNOWFLAKES; i++) {
        snowFlakes[i].x    = frandr(0, SCREEN_W);
        snowFlakes[i].y    = frandr(0, WEATHER_SKY_H);
        snowFlakes[i].spd  = frandr(0.4f, 1.6f);
        snowFlakes[i].sway = frandr(0, 6.28f);
    }
    _lightningTimer = frandr(120, 300);
    _lightningFlash = 0;
}

void updateWeatherEffects() {
    for (int i = 0; i < numClouds; i++) {
        clouds[i].x += clouds[i].spd;
        if (clouds[i].x >  SCREEN_W + 120) clouds[i].x = -120;
        if (clouds[i].x < -120)            clouds[i].x =  SCREEN_W + 120;
    }
    if (currentWeather == WEATHER_RAINY || currentWeather == WEATHER_STORMY) {
        for (int i = 0; i < MAX_RAINDROPS; i++) {
            rainDrops[i].x += 1.8f;
            rainDrops[i].y += rainDrops[i].spd;
            if (rainDrops[i].y >= WEATHER_SKY_H || rainDrops[i].x >= SCREEN_W) {
                rainDrops[i].x   = frandr(-20, SCREEN_W);
                rainDrops[i].y   = frandr(-12, 0);
                rainDrops[i].spd = frandr(7.0f, 13.0f);
            }
        }
    }
    if (currentWeather == WEATHER_SNOWY) {
        for (int i = 0; i < MAX_SNOWFLAKES; i++) {
            snowFlakes[i].sway += 0.04f;
            snowFlakes[i].x    += sinf(snowFlakes[i].sway) * 0.5f;
            snowFlakes[i].y    += snowFlakes[i].spd;
            if (snowFlakes[i].y >= WEATHER_SKY_H) {
                snowFlakes[i].x = frandr(0, SCREEN_W);
                snowFlakes[i].y = frandr(-5, 0);
            }
        }
    }
    if (currentWeather == WEATHER_STORMY) {
        if (_lightningFlash > 0) {
            _lightningFlash--;
        } else {
            _lightningTimer -= 1.0f;
            if (_lightningTimer <= 0) {
                _lightningFlash = 3;
                _lightBoltX     = frandr(80, SCREEN_W - 80);
                _lightningTimer = frandr(80, 260);
            }
        }
    }
}

static void drawCloud(float cx, float cy, float cw, float ch, uint32_t col) {
    canvas.fillEllipse((int)cx,
                       (int)(cy - ch * 0.28f),
                       (int)(cw * 0.50f), (int)(ch * 0.32f), col);
    canvas.fillEllipse((int)(cx - cw * 0.08f),
                       (int)(cy - ch * 0.62f),
                       (int)(cw * 0.26f), (int)(ch * 0.42f), col);
}

static uint32_t colorLerp(uint32_t a, uint32_t b, float t) {
    if (t <= 0.0f) return a;
    if (t >= 1.0f) return b;
    int ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
    int br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
    return ((uint32_t)(ar + (int)((br - ar) * t + 0.5f)) << 16) |
           ((uint32_t)(ag + (int)((bg - ag) * t + 0.5f)) <<  8) |
            (uint32_t)(ab + (int)((bb - ab) * t + 0.5f));
}

static void initStars() {
    for (int i = 0; i < NUM_STARS; i++) {
        skyStars[i].x     = (uint16_t)random(0, SCREEN_W);
        skyStars[i].y     = (uint8_t) random(2, WEATHER_SKY_H - 4);
        skyStars[i].phase = (uint8_t) random(0, 100);
    }
}

void drawWeatherSky() {
    uint32_t weatherTop, weatherBot, cloudCol;
    switch (currentWeather) {
        case WEATHER_SUNNY:
            weatherTop = 0x1A78C8; weatherBot = 0x64B5E8; cloudCol = 0xFFFFFF; break;
        case WEATHER_PARTLY_CLOUDY:
            weatherTop = 0x2288CC; weatherBot = 0x77AEDD; cloudCol = 0xEEEEFF; break;
        case WEATHER_CLOUDY:
            weatherTop = 0x556677; weatherBot = 0x8899AA; cloudCol = 0xBBBBCC; break;
        case WEATHER_RAINY:
            weatherTop = 0x334455; weatherBot = 0x556677; cloudCol = 0x5A6A7A; break;
        case WEATHER_STORMY:
            weatherTop = 0x111827; weatherBot = 0x1A2233; cloudCol = 0x2A3344; break;
        case WEATHER_SNOWY:
            weatherTop = 0x8899AA; weatherBot = 0xAABBCC; cloudCol = 0xCCDDEE; break;
        case WEATHER_FOGGY:
            weatherTop = 0x7788AA; weatherBot = 0xAABBCC; cloudCol = 0xBBCCDD; break;
        default:
            weatherTop = 0x1A78C8; weatherBot = 0x64B5E8; cloudCol = 0xFFFFFF; break;
    }

    float dp = getDayProgress();
    float dayFactor;
    if      (dp < 0.18f) dayFactor = 0.0f;
    else if (dp < 0.28f) dayFactor = (dp - 0.18f) * 10.0f;
    else if (dp < 0.72f) dayFactor = 1.0f;
    else if (dp < 0.82f) dayFactor = 1.0f - (dp - 0.72f) * 10.0f;
    else                 dayFactor = 0.0f;

    const uint32_t NIGHT_TOP = 0x000510UL, NIGHT_BOT = 0x001530UL;
    const uint32_t DAWN_TOP  = 0xBB4410UL, DAWN_BOT  = 0xFF8840UL;

    uint32_t skyTop, skyBot;
    if (dayFactor < 0.5f) {
        float t = dayFactor * 2.0f;
        skyTop = colorLerp(NIGHT_TOP, DAWN_TOP, t);
        skyBot = colorLerp(NIGHT_BOT, DAWN_BOT, t);
    } else {
        float t = (dayFactor - 0.5f) * 2.0f;
        skyTop = colorLerp(DAWN_TOP, weatherTop, t);
        skyBot = colorLerp(DAWN_BOT, weatherBot, t);
    }
    cloudCol = colorLerp(0x223344UL, cloudCol, dayFactor);

    for (int band = 0; band < 8; band++) {
        int   y0 = band       * WEATHER_SKY_H / 8;
        int   y1 = (band + 1) * WEATHER_SKY_H / 8;
        float t  = (float)band / 7.0f;
        uint8_t r = (uint8_t)(((skyTop >> 16 & 0xFF) * (1.0f - t)) + ((skyBot >> 16 & 0xFF) * t));
        uint8_t g = (uint8_t)(((skyTop >>  8 & 0xFF) * (1.0f - t)) + ((skyBot >>  8 & 0xFF) * t));
        uint8_t b = (uint8_t)(((skyTop       & 0xFF) * (1.0f - t)) + ((skyBot       & 0xFF) * t));
        canvas.fillRect(0, y0, SCREEN_W, y1 - y0 + 1, ((uint32_t)r << 16) | ((uint32_t)g << 8) | b);
    }

    if (dayFactor < 0.9f) {
        float starAlpha = 1.0f - dayFactor / 0.9f;
        for (int i = 0; i < NUM_STARS; i++) {
            float twinkle = 0.55f + 0.45f * sinf(tick * 0.07f + skyStars[i].phase * 0.13f);
            uint8_t br = (uint8_t)(starAlpha * twinkle * 210);
            if (br < 15) continue;
            uint32_t sc = ((uint32_t)br << 16) | ((uint32_t)br << 8) |
                           (uint32_t)min((int)(br + 35), 255);
            canvas.drawPixel(skyStars[i].x, skyStars[i].y, sc);
            if (skyStars[i].phase % 5 == 0 && br > 150) {
                uint32_t dim = sc >> 1 & 0x7F7F7FUL;
                canvas.drawPixel(skyStars[i].x - 1, skyStars[i].y,     dim);
                canvas.drawPixel(skyStars[i].x + 1, skyStars[i].y,     dim);
                canvas.drawPixel(skyStars[i].x,     skyStars[i].y - 1, dim);
                canvas.drawPixel(skyStars[i].x,     skyStars[i].y + 1, dim);
            }
        }
    }

    if (dp >= 0.25f && dp <= 0.75f && dayFactor > 0.05f) {
        float sunProg = (dp - 0.25f) / 0.50f;
        int   sunX    = (int)(sunProg * SCREEN_W);
        int   sunY    = (WEATHER_SKY_H - 8) -
                        (int)(sinf((float)M_PI * sunProg) * (WEATHER_SKY_H - 14));
        float nearH   = 1.0f - sinf((float)M_PI * sunProg);
        uint32_t core = colorLerp(0xFFFFAAUL, 0xFF8800UL, nearH);
        uint32_t glow = colorLerp(0xFFDD44UL, 0xFF4400UL, nearH);
        core = colorLerp(skyTop, core, dayFactor);
        glow = colorLerp(skyTop, glow, dayFactor);
        canvas.fillCircle(sunX, sunY, 13, colorLerp(skyTop, glow, 0.45f));
        canvas.fillCircle(sunX, sunY,  9, glow);
        canvas.fillCircle(sunX, sunY,  5, core);
    }

    if ((dp > 0.75f || dp < 0.25f) && dayFactor < 0.9f) {
        float nightLen = 0.50f;
        float moonProg = (dp > 0.75f) ? (dp - 0.75f) / nightLen : (dp + 0.25f) / nightLen;
        int   moonX = (int)(moonProg * SCREEN_W);
        int   moonY = (WEATHER_SKY_H - 8) -
                      (int)(sinf((float)M_PI * moonProg) * (WEATHER_SKY_H - 14));
        float moonVis   = 1.0f - dayFactor / 0.9f;
        uint32_t moonCol   = colorLerp(skyTop, 0xDDDDE8UL, moonVis);
        uint32_t shadowCol = colorLerp(moonCol, skyTop, 0.85f);
        canvas.fillCircle(moonX,     moonY,     7, moonCol);
        canvas.fillCircle(moonX + 3, moonY - 2, 6, shadowCol);
    }

    if (_lightningFlash > 0) {
        canvas.fillRect(0, 0, SCREEN_W, WEATHER_SKY_H, 0xCCDDFFUL);
        int bx = (int)_lightBoltX, by = 4;
        while (by < WEATHER_SKY_H) {
            int nx = bx + (int)random(-14, 14);
            int ny = by + (int)random(10, 22);
            if (ny > WEATHER_SKY_H) ny = WEATHER_SKY_H;
            canvas.drawLine(bx,     by, nx,     ny, 0xFFFFAAUL);
            canvas.drawLine(bx + 1, by, nx + 1, ny, 0xFFFF66UL);
            bx = nx; by = ny;
        }
    }

    for (int i = 0; i < numClouds; i++)
        drawCloud(clouds[i].x, clouds[i].y, clouds[i].w, clouds[i].h, cloudCol);

    if (currentWeather == WEATHER_RAINY || currentWeather == WEATHER_STORMY) {
        uint32_t rainCol = (currentWeather == WEATHER_STORMY) ? 0x7799BBUL : 0x88AACCUL;
        for (int i = 0; i < MAX_RAINDROPS; i++) {
            int rx = (int)rainDrops[i].x, ry = (int)rainDrops[i].y;
            if (ry < 0) continue;
            int ey = ry + 5; if (ey >= WEATHER_SKY_H) ey = WEATHER_SKY_H - 1;
            canvas.drawLine(rx, ry, rx + 2, ey, rainCol);
        }
    }

    if (currentWeather == WEATHER_SNOWY) {
        for (int i = 0; i < MAX_SNOWFLAKES; i++) {
            int sx = (int)snowFlakes[i].x, sy = (int)snowFlakes[i].y;
            if (sy >= 0 && sy < WEATHER_SKY_H)
                canvas.fillRect(sx, sy, 2, 2, 0xEEEEFFUL);
        }
    }

    if (currentWeather == WEATHER_FOGGY) {
        for (int y = 0; y < WEATHER_SKY_H; y += 12)
            canvas.fillRect(0, y, SCREEN_W, 5, 0xAABBCCUL);
    }
}

// Telemetry publisher — included here (not at the top) because it references the
// aquarium globals declared above (fish[], fishColor, snail, plants, weather…).
#include "telemetry.h"

// ═══════════════════════════════════════════════════════════════════════════════
//  setup
// ═══════════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    std::srand((unsigned)time(nullptr));
    if (BUTTON_PIN >= 0) pinMode(BUTTON_PIN, INPUT_PULLUP);

    Serial.println("Calling display.init()...");
    if (!display.init()) {
        printf("display.init() failed — exiting\n");
        exit(1);
    }
    Serial.printf("display W=%d  H=%d\n", display.width(), display.height());
    display.setBrightness(255);
    display.setRotation(0);
    display.fillScreen(0x000000UL);

    initWeather();
    initDayNight();
    telemetryInit();

    for (int x = 0; x < SCREEN_W; x++) {
        float h = sinf(x * 0.018f) * 4.0f
                + sinf(x * 0.063f) * 2.5f
                + sinf(x * 0.140f) * 1.5f;
        terrainY[x] = (int16_t)(SCREEN_H - 18 + (int)h);
    }

    canvas.setPsram(true);
    if (!canvas.createSprite(SCREEN_W, SCREEN_H))
        printf("WARNING: canvas sprite allocation failed\n");
    else
        Serial.println("Canvas sprite created OK");

    for (int i = 0; i < NUM_BUBBLES; i++) resetBubble(i, true);

    for (int i = 0; i < NUM_BG_PLANTS; i++) {
        bgPlants[i].baseX = (uint16_t)(15 + i * (SCREEN_W / NUM_BG_PLANTS) + random(0, 25));
        bgPlants[i].segs  = (uint8_t)(5 + random(0, 7));
        bgPlants[i].type  = (uint8_t)(i % 2);
    }

    for (int i = 0; i < NUM_WEEDS; i++) {
        weeds[i].baseX       = (uint16_t)(40 + i * (SCREEN_W / (NUM_WEEDS + 1)));
        weeds[i].segs        = (uint8_t)(8 + random(0, 7));
        weeds[i].numBranches = (uint8_t)(1 + random(0, 2));
        for (int b = 0; b < 2; b++) {
            weeds[i].branchAt[b]   = (uint8_t)(2 + random(0, weeds[i].segs - 3));
            weeds[i].branchSide[b] = (random(0, 2) == 0) ? 1 : -1;
        }
    }

    for (int i = 0; i < NUM_FG_HORNWORT; i++) {
        fgHornworts[i].baseX = (uint16_t)(80 + i * (SCREEN_W / NUM_FG_HORNWORT) + random(0, 40));
        fgHornworts[i].segs  = (uint8_t)(6 + random(0, 6));
    }

    initFishEntry(0, 150, 210, 0.20f,  3.0f, FISH_PAIR, 1);
    initFishEntry(1, 330, 240, 0.35f, -2.5f, FISH_PAIR, 0);

    for (int i = 0; i < numSchool; i++)
        initFishEntry(MAX_PAIR + i,
            frandr(380, 620), frandr(130, 330), frandr(0.40f, 0.75f),
            frandr(-2.0f, 2.0f), FISH_SCHOOL, -1);

    for (int i = 0; i < numSchool2; i++)
        initFishEntry(MAX_PAIR + MAX_SCHOOL + i,
            frandr(150, 400), frandr(150, 350), frandr(0.40f, 0.75f),
            frandr(-2.0f, 2.0f), FISH_SCHOOL2, -1);

    for (int i = 0; i < numAngel; i++)
        initFishEntry(MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2 + i,
            frandr(200, 600), frandr(90, 320), frandr(0.25f, 0.65f),
            frandr(-3.0f, 3.0f), FISH_ANGEL, -1);

    for (int i = 0; i < MAX_FLAKES; i++) flakes[i].active = false;

    initWeatherEffects();
    initStars();

    snail.x           = frandr(80, SCREEN_W - 80);
    snail.spd         = frandr(0.12f, 0.25f);
    snail.facingRight = (random(0, 2) == 0);

    starfish.x           = frandr(80, SCREEN_W - 80);
    starfish.spd         = frandr(0.10f, 0.20f);
    starfish.facingRight = (random(0, 2) == 0);

    lastFrameMs = millis();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Food drop
// ═══════════════════════════════════════════════════════════════════════════════
void dropFood(int touchX = -1, int touchY = -1) {
    int n = random(5, 11);
    int spawned = 0;
    bool hasTouch = (touchX >= 0);
    for (int i = 0; i < MAX_FLAKES && spawned < n; i++) {
        if (!flakes[i].active) {
            if (hasTouch) {
                flakes[i].x = constrain(touchX + frandr(-60, 60), 20.0f, (float)(SCREEN_W - 20));
                flakes[i].y = constrain((float)touchY, (float)(TANK_TOP + 5), (float)(SCREEN_H - 80));
            } else {
                flakes[i].x = frandr(40, SCREEN_W - 40);
                flakes[i].y = (float)(TANK_TOP + 5);
            }
            flakes[i].spd      = frandr(0.4f, 1.0f);
            flakes[i].active   = true;
            flakes[i].shape    = (uint8_t)random(0, 3);
            flakes[i].colorIdx = (uint8_t)(spawned % 7);
            spawned++;
        }
    }
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        if (fish[i].fullTimer <= 0) {
            fish[i].goingForFood = true;
            fish[i].targetFlake  = -1;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Update — snail / starfish / bubbles / flakes
// ═══════════════════════════════════════════════════════════════════════════════
void updateSnail() {
    float move = snail.facingRight ? snail.spd : -snail.spd;
    snail.x += move;
    if (snail.x > SCREEN_W - 55) { snail.x = SCREEN_W - 55; snail.facingRight = false; }
    if (snail.x < 55)             { snail.x = 55;             snail.facingRight = true;  }
}

void updateStarfish() {
    float move = starfish.facingRight ? starfish.spd : -starfish.spd;
    starfish.x += move;
    if (starfish.x > SCREEN_W - 40) { starfish.x = SCREEN_W - 40; starfish.facingRight = false; }
    if (starfish.x < 40)             { starfish.x = 40;             starfish.facingRight = true;  }
}

void updateBubbles() {
    for (int i = 0; i < NUM_BUBBLES; i++) {
        bubbles[i].y -= bubbles[i].spd;
        bubbles[i].x += sinf(tick * 0.06f + i * 1.57f) * 0.8f;
        bubbles[i].x  = constrain(bubbles[i].x, 2.0f, (float)(SCREEN_W - 2));
        if (bubbles[i].y < TANK_TOP) resetBubble(i, false);
    }
}

void updateFlakes() {
    for (int i = 0; i < MAX_FLAKES; i++) {
        if (!flakes[i].active) continue;
        flakes[i].y += flakes[i].spd;
        flakes[i].x += sinf(tick * 0.03f + i * 0.9f) * 0.5f;
        if (flakes[i].y > SCREEN_H - 4) flakes[i].active = false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Update — fish
// ═══════════════════════════════════════════════════════════════════════════════
bool anyFlakeActive() {
    for (int i = 0; i < MAX_FLAKES; i++) if (flakes[i].active) return true;
    return false;
}

int nearestFlake(const Fish& f) {
    int best = -1; float bd = 1e9f;
    for (int i = 0; i < MAX_FLAKES; i++) {
        if (!flakes[i].active) continue;
        float dx = flakes[i].x - f.x, dy = flakes[i].y - f.y;
        float d  = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

void updateFish() {
    float scx = 0, scy = 0, scz = 0;
    if (numSchool > 0) {
        for (int i = MAX_PAIR; i < MAX_PAIR + numSchool; i++) { scx += fish[i].x; scy += fish[i].y; scz += fish[i].z; }
        scx /= numSchool; scy /= numSchool; scz /= numSchool;
    }
    float sc2x = 0, sc2y = 0, sc2z = 0;
    if (numSchool2 > 0) {
        for (int i = MAX_PAIR + MAX_SCHOOL; i < MAX_PAIR + MAX_SCHOOL + numSchool2; i++) { sc2x += fish[i].x; sc2y += fish[i].y; sc2z += fish[i].z; }
        sc2x /= numSchool2; sc2y /= numSchool2; sc2z /= numSchool2;
    }
    float sacx = 0, sacy = 0, sacz = 0;
    if (numAngel > 0) {
        int base = MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2;
        for (int i = base; i < base + numAngel; i++) { sacx += fish[i].x; sacy += fish[i].y; sacz += fish[i].z; }
        sacx /= numAngel; sacy /= numAngel; sacz /= numAngel;
    }

    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        float ax = 0, ay = 0, az = 0;

        if (f.fullTimer > 0) { f.fullTimer -= 1.0f; if (f.fullTimer <= 0) f.fullTimer = 0; }

        if (f.goingForFood && f.fullTimer <= 0) {
            if (!anyFlakeActive()) { f.goingForFood = false; f.targetFlake = -1; }
            else {
                if (f.targetFlake < 0 || !flakes[f.targetFlake].active) f.targetFlake = nearestFlake(f);
                if (f.targetFlake >= 0) {
                    if (f.z > 0.25f) { az += (0.15f - f.z) * 0.06f; }
                    else { ax += (flakes[f.targetFlake].x - f.x) * 0.05f; ay += (flakes[f.targetFlake].y - f.y) * 0.05f; }
                }
            }
        } else {
            f.wanderCD -= 1.0f;
            if (f.wanderCD <= 0.0f) {
                if (f.type == FISH_PAIR)  { f.chasing = !f.chasing; f.wanderCD = f.chasing ? frandr(30, 70) : frandr(40, 90); }
                else if (f.type == FISH_ANGEL) { f.wanderCD = frandr(8, 28); }
                else                           { f.wanderCD = frandr(15, 50); }

                if (f.type == FISH_PAIR && f.partner >= 0 && isFishActive(f.partner)) {
                    Fish& partner = fish[f.partner];
                    if (f.chasing) {
                        f.tx = constrain(partner.x + frandr(-40, 40), 30.0f, (float)(SCREEN_W - 30));
                        f.ty = constrain(partner.y + frandr(-30, 30), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                        f.tz = constrain(partner.z + frandr(-0.10f, 0.10f), 0.05f, 0.72f);
                    } else {
                        float fleeX = f.x + (f.x - partner.x) * 1.5f;
                        float fleeY = f.y + (f.y - partner.y) * 1.2f;
                        f.tx = constrain(fleeX + frandr(-60, 60), 30.0f, (float)(SCREEN_W - 30));
                        f.ty = constrain(fleeY + frandr(-40, 40), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                        f.tz = constrain(partner.z + frandr(-0.15f, 0.15f), 0.05f, 0.72f);
                    }
                } else if (f.type == FISH_PAIR) {
                    f.tx = frandr(30.0f, (float)(SCREEN_W - 30));
                    f.ty = frandr((float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                    f.tz = constrain(f.tz + frandr(-0.12f, 0.12f), 0.05f, 0.72f);
                } else if (f.type == FISH_SCHOOL) {
                    f.tx = constrain(scx + frandr(-160, 160), 30.0f, (float)(SCREEN_W - 30));
                    f.ty = constrain(scy + frandr(-90,   90), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                    f.tz = constrain(scz + frandr(-0.15f, 0.15f), 0.05f, 0.72f);
                } else if (f.type == FISH_SCHOOL2) {
                    f.tx = constrain(sc2x + frandr(-160, 160), 30.0f, (float)(SCREEN_W - 30));
                    f.ty = constrain(sc2y + frandr(-90,   90), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                    f.tz = constrain(sc2z + frandr(-0.15f, 0.15f), 0.05f, 0.72f);
                } else {
                    f.tx = constrain(sacx + frandr(-120, 120), 30.0f, (float)(SCREEN_W - 30));
                    f.ty = constrain(sacy + frandr(-110, 110), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
                    f.tz = constrain(sacz + frandr(-0.18f, 0.18f), 0.05f, 0.72f);
                }
            }

            float seekStr = (f.type == FISH_PAIR && f.chasing) ? 0.018f
                          : (f.type == FISH_ANGEL)             ? 0.020f
                          :                                      0.012f;
            ax += (f.tx - f.x) * seekStr;
            ay += (f.ty - f.y) * seekStr;
            az += (f.tz - f.z) * 0.010f;

            if (f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2) {
                float cx = (f.type == FISH_SCHOOL) ? scx  : sc2x;
                float cy = (f.type == FISH_SCHOOL) ? scy  : sc2y;
                float cz = (f.type == FISH_SCHOOL) ? scz  : sc2z;
                int   js = (f.type == FISH_SCHOOL) ? MAX_PAIR : (MAX_PAIR + MAX_SCHOOL);
                int   je = (f.type == FISH_SCHOOL) ? (MAX_PAIR + numSchool) : (MAX_PAIR + MAX_SCHOOL + numSchool2);
                ax += (cx - f.x) * 0.010f; ay += (cy - f.y) * 0.007f; az += (cz - f.z) * 0.007f;
                for (int j = js; j < je; j++) {
                    if (j == i || !isFishActive(j)) continue;
                    float dx = f.x - fish[j].x, dy = f.y - fish[j].y;
                    float d2 = dx * dx + dy * dy;
                    if (d2 < 80.0f * 80.0f && d2 > 0.01f) { float inv = 8.0f / d2; ax += dx * inv; ay += dy * inv; }
                }
            } else if (f.type == FISH_ANGEL) {
                ax += (sacx - f.x) * 0.012f; ay += (sacy - f.y) * 0.010f; az += (sacz - f.z) * 0.008f;
                int base = MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2;
                for (int j = base; j < base + numAngel; j++) {
                    if (j == i || !isFishActive(j)) continue;
                    float dx = f.x - fish[j].x, dy = f.y - fish[j].y;
                    float d2 = dx * dx + dy * dy;
                    if (d2 < 60.0f * 60.0f && d2 > 0.01f) { float inv = 7.0f / d2; ax += dx * inv; ay += dy * inv; }
                }
            }
        }

        ax += boundAccel(f.x,  30,             SCREEN_W - 30);
        ay += boundAccel(f.y,  TANK_TOP + 20,  SCREEN_H - 80);
        az += boundAccel(f.z,  0.0f,     0.75f, 0.08f);

        float maxV  = f.goingForFood ? 8.0f : (f.type == FISH_PAIR && f.chasing) ? 7.0f : (f.type == FISH_ANGEL) ? 7.0f : 5.5f;
        float maxVz = 0.015f;
        f.vx = constrain(f.vx + ax, -maxV,       maxV);
        f.vy = constrain(f.vy + ay, -maxV * 0.5f, maxV * 0.5f);
        f.vz = constrain(f.vz + az, -maxVz,       maxVz);
        f.vx *= 0.85f; f.vy *= 0.85f; f.vz *= 0.88f;
        f.x += f.vx; f.y += f.vy; f.z += f.vz;
        f.x = constrain(f.x, 5.0f,                (float)(SCREEN_W - 5));
        f.y = constrain(f.y, (float)(TANK_TOP + 5), (float)(SCREEN_H - 60));
        f.z = constrain(f.z, 0.0f, 0.78f);
        if (fabsf(f.vx) > 0.4f) f.facingRight = (f.vx > 0);

        if (f.goingForFood && f.targetFlake >= 0 && flakes[f.targetFlake].active) {
            int sx = projX(f.x, f.z), sy = projY(f.y, f.z);
            int hw = fishHW(f), ts = fishTS(f);
            int mouthX = f.facingRight ? (sx + hw) : (sx - hw);
            int flkX = (int)flakes[f.targetFlake].x, flkY = (int)flakes[f.targetFlake].y;
            int hitR = 10 + ts * 4;
            if (abs(mouthX - flkX) < hitR && abs(sy - flkY) < hitR) {
                flakes[f.targetFlake].active = false;
                f.goingForFood = false; f.targetFlake = -1; f.fullTimer = 30 * 20;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Draw helpers  (identical to ESP32 version)
// ═══════════════════════════════════════════════════════════════════════════════

void drawSnail() {
    int bx = (int)snail.x;
    int by = terrainY[constrain(bx, 0, SCREEN_W - 1)];
    int d  = snail.facingRight ? 1 : -1;
    const uint32_t BODY = 0xDDB060UL, SHELL = 0x7A2E0AUL, SWIRL = 0xB05020UL;
    canvas.fillCircle(bx - d * 4, by - 8, 8, SHELL);
    canvas.drawCircle(bx - d * 3, by - 8, 5, SWIRL);
    canvas.drawCircle(bx - d * 2, by - 8, 2, SWIRL);
    canvas.drawPixel (bx - d * 2, by - 8, BODY);
    canvas.fillEllipse(bx, by - 3, 12, 3, BODY);
    canvas.fillCircle(bx + d * 10, by - 5, 5, BODY);
    canvas.drawLine(bx + d * 8,  by - 9,  bx + d * 6,  by - 15, BODY);
    canvas.drawLine(bx + d * 12, by - 9,  bx + d * 14, by - 15, BODY);
    canvas.fillCircle(bx + d * 6,  by - 15, 2, BODY);
    canvas.fillCircle(bx + d * 14, by - 15, 2, BODY);
    canvas.fillCircle(bx + d * 6,  by - 15, 1, 0x111111UL);
    canvas.fillCircle(bx + d * 14, by - 15, 1, 0x111111UL);
}

void drawStarfish() {
    const uint32_t ORANGE = 0xFF6600UL;
    int bx = (int)starfish.x;
    int by = terrainY[constrain(bx, 0, SCREEN_W - 1)] - 10;
    float rot = sinf(tick * 0.018f) * 0.18f;
    const float R = 9.0f, r = 4.0f;
    float px[10], py[10];
    for (int i = 0; i < 10; i++) {
        float a = rot - 1.5708f + i * 0.6283f;
        float rad = (i % 2 == 0) ? R : r;
        px[i] = bx + rad * cosf(a);
        py[i] = by + rad * sinf(a);
    }
    for (int i = 0; i < 10; i++) {
        int j = (i + 1) % 10;
        canvas.fillTriangle(bx, by, (int)px[i], (int)py[i], (int)px[j], (int)py[j], ORANGE);
    }
}

void updateBoat() {
    uint32_t now = millis();
    if (!boat.active) {
        if (now - boat.lastLaunchMs >= BOAT_LAUNCH_MS) { boat.x = (float)(SCREEN_W + 10); boat.active = true; }
        return;
    }
    boat.x -= 0.5f;
    if (boat.x < -(float)(BOAT_W + 10)) { boat.active = false; boat.lastLaunchMs = millis(); }
}

void drawBoat() {
    if (!boat.active) return;
    int bx = (int)boat.x, by = TANK_TOP - 23;
    const uint32_t hullDark = 0x7B3A10UL, hullMid = 0xA0522DUL, deckCol = 0xD2B48CUL;
    const uint32_t cabinCol = 0xFDF5E6UL, roofCol = 0x888888UL, winCol = 0x87CEEBUL;
    const uint32_t rimCol   = 0x555555UL, chimCol = 0x444444UL, smokeCol = 0xBBBBBBUL;

    canvas.fillTriangle(bx + 4, by, bx + 72, by, bx + 38, by + 6, hullDark);
    canvas.fillRect(bx + 2, by - 11, 72, 11, hullMid);
    canvas.fillTriangle(bx,     by, bx + 2,  by - 8, bx + 2,  by, hullDark);
    canvas.fillTriangle(bx + 74, by, bx + 74, by - 8, bx + 72, by - 8, hullDark);
    canvas.fillRect(bx + 2, by - 11, 72, 2, 0xC07040UL);
    canvas.fillRect(bx + 2, by - 13, 72, 2, deckCol);
    canvas.fillRect(bx + 16, by - 25, 40, 12, cabinCol);
    canvas.fillRect(bx + 14, by - 27, 44,  2, roofCol);
    canvas.drawRect(bx + 16, by - 25, 40, 12, 0xAAAAAAUL);
    canvas.fillCircle(bx + 26, by - 20, 4, winCol);
    canvas.fillCircle(bx + 44, by - 20, 4, winCol);
    canvas.drawCircle(bx + 26, by - 20, 4, rimCol);
    canvas.drawCircle(bx + 44, by - 20, 4, rimCol);
    canvas.fillRect(bx + 52, by - 37, 8, 14, chimCol);
    canvas.fillRect(bx + 50, by - 39, 12, 3, chimCol);
    for (int p = 0; p < 3; p++) {
        float phase = fmodf(tick * 0.6f + p * 20.0f, 60.0f);
        int sx = bx + 55 - (int)(phase * 0.6f);
        int sy = by - 42  - (int)(phase * 0.35f);
        int sr = 4 - (int)(phase / 20.0f); if (sr < 1) sr = 1;
        uint8_t alpha = (uint8_t)(180 - phase * 2);
        uint32_t sc = (alpha > 150) ? 0xCCCCCCUL : (alpha > 100) ? smokeCol : 0xAAAAAAUL;
        canvas.fillCircle(sx, sy, sr + 1, sc);
    }
}

void drawBackground() {
    canvas.fillRect(0, 0, SCREEN_W, TANK_TOP, 0x1A1A1AUL);
    for (int y = TANK_TOP; y < SCREEN_H; y += 3) {
        float fy = (float)(y - TANK_TOP);
        float w  = sinf(fy * 0.040f + tick * 0.10f)  * 14.0f
                 + sinf(fy * 0.016f - tick * 0.034f) *  8.0f;
        int g = constrain(0x30 + (int)(w * 0.4f), 0, 255);
        int b = constrain(0x60 + (int)w,          0, 255);
        canvas.fillRect(0, y, SCREEN_W, 3, ((uint32_t)g << 8) | (uint32_t)b);
    }
    for (int x = 0; x < SCREEN_W; x++)
        canvas.drawFastVLine(x, terrainY[x], SCREEN_H - terrainY[x], COL_SAND);
}

void drawTankRim() {
    canvas.fillRect(0, TANK_TOP - 22, SCREEN_W, 12, 0x484848UL);
    canvas.fillRect(0, TANK_TOP - 22, SCREEN_W,  1, 0xB0B0B0UL);
    canvas.fillRect(0, TANK_TOP - 11, SCREEN_W,  1, 0x202020UL);
    canvas.fillRect(0, TANK_TOP - 10, SCREEN_W,  9, 0x2E6888UL);
    canvas.fillRect(0, TANK_TOP - 10, SCREEN_W,  2, 0xAADDEEUL);
    canvas.fillRect(0, TANK_TOP -  4, SCREEN_W,  2, 0x5098B8UL);
    canvas.fillRect(0, TANK_TOP -  2, SCREEN_W,  1, 0x88CCDDUL);
    canvas.fillRect(0, TANK_TOP -  1, SCREEN_W,  1, 0xDDEEFFUL);
    canvas.fillRect(0, TANK_TOP,      SCREEN_W,  4, 0x061018UL);
}

void drawBubbles() {
    for (int i = 0; i < NUM_BUBBLES; i++) {
        int bx = (int)bubbles[i].x, by = (int)bubbles[i].y;
        if (by - (int)bubbles[i].r < TANK_TOP) continue;
        canvas.drawCircle(bx, by, bubbles[i].r,     COL_BUBBLE);
        canvas.drawCircle(bx, by, bubbles[i].r - 1, COL_BUBBLE);
    }
}

static void drawLeaf(int cx, int cy, int side, int rx, int ry) {
    int lx = cx + side * (rx + 2);
    canvas.fillEllipse(lx, cy, rx, ry, COL_WEED_LEAF);
    canvas.drawLine(cx, cy, lx, cy, COL_WEED);
}

void drawBgPlants() {
    for (int i = 0; i < NUM_BG_PLANTS; i++) {
        BgPlant& p = bgPlants[i];
        if (p.type == 0) {
            int sx[14], sy[14];
            sx[0] = p.baseX; sy[0] = SCREEN_H - 20;
            for (int s = 1; s <= p.segs; s++) {
                float sway = sinf(tick * 0.035f + i * 1.60f + s * 0.42f) * s * 1.1f;
                sx[s] = p.baseX + (int)sway;
                sy[s] = SCREEN_H - 20 - s * BG_PLANT_SEG_H;
            }
            for (int s = 0; s < p.segs; s++)
                canvas.drawLine(sx[s], sy[s], sx[s+1], sy[s+1], COL_BG_PLANT);
            for (int s = 1; s < p.segs; s++) {
                int lx   = (sx[s-1] + sx[s]) / 2;
                int ly   = (sy[s-1] + sy[s]) / 2 - 2;
                int side = (s % 2 == 0) ? 1 : -1;
                int rx   = 4 + (s % 2);
                canvas.fillEllipse(lx + side * rx, ly, rx, 2, COL_BG_LEAF);
            }
        } else {
            int baseY = SCREEN_H - 20;
            float tipSway = sinf(tick * 0.028f + i * 1.85f) * 3.0f;
            for (int s = 0; s <= p.segs; s++) {
                float t  = (float)s / p.segs;
                int   cx = p.baseX + (int)(tipSway * t);
                int   cy = baseY - s * BG_PLANT_SEG_H;
                if (s < p.segs) {
                    float tn = (float)(s + 1) / p.segs;
                    int   nx = p.baseX + (int)(tipSway * tn);
                    int   ny = cy - BG_PLANT_SEG_H;
                    canvas.drawLine(cx, cy, nx, ny, COL_BG_PLANT);
                }
                int needleLen = (int)((1.0f - t * 0.65f) * 9.0f);
                if (needleLen > 1) {
                    canvas.drawLine(cx, cy, cx - needleLen, cy - 1, COL_BG_LEAF);
                    canvas.drawLine(cx, cy, cx + needleLen, cy - 1, COL_BG_LEAF);
                }
            }
        }
    }
}

void drawFgHornwort() {
    for (int i = 0; i < NUM_FG_HORNWORT; i++) {
        FgHornwort& h = fgHornworts[i];
        int baseY = SCREEN_H - 20;
        float tipSway = sinf(tick * 0.05f + i * 1.30f) * 5.0f;
        for (int s = 0; s <= h.segs; s++) {
            float t  = (float)s / h.segs;
            int   cx = h.baseX + (int)(tipSway * t);
            int   cy = baseY - s * WEED_SEG_H;
            if (s < h.segs) {
                float tn = (float)(s + 1) / h.segs;
                int   nx = h.baseX + (int)(tipSway * tn);
                int   ny = cy - WEED_SEG_H;
                canvas.drawLine(cx,     cy, nx,     ny, COL_WEED);
                canvas.drawLine(cx + 1, cy, nx + 1, ny, COL_WEED);
            }
            int needleLen = (int)((1.0f - t * 0.60f) * 13.0f);
            if (needleLen > 1) {
                canvas.drawLine(cx, cy, cx - needleLen, cy - 2, COL_WEED_LEAF);
                canvas.drawLine(cx, cy, cx + needleLen, cy - 2, COL_WEED_LEAF);
            }
        }
    }
}

void drawSeaweed() {
    for (int i = 0; i < NUM_WEEDS; i++) {
        Seaweed& w = weeds[i];
        int sx[15], sy[15];
        sx[0] = w.baseX; sy[0] = SCREEN_H - 20;
        for (int s = 1; s <= w.segs; s++) {
            float sway = sinf(tick * 0.05f + i * 1.20f + s * 0.45f) * s * 2.0f;
            sx[s] = w.baseX + (int)sway;
            sy[s] = SCREEN_H - 20 - s * WEED_SEG_H;
        }
        for (int s = 0; s < w.segs; s++) {
            canvas.drawLine(sx[s],     sy[s], sx[s+1],     sy[s+1], COL_WEED);
            canvas.drawLine(sx[s] + 1, sy[s], sx[s+1] + 1, sy[s+1], COL_WEED);
        }
        for (int s = 1; s < w.segs; s++) {
            int lx   = (sx[s-1] + sx[s]) / 2;
            int ly   = (sy[s-1] + sy[s]) / 2 - 2;
            int side = (s % 2 == 0) ? 1 : -1;
            int rx   = 5 + (s % 3);
            drawLeaf(lx, ly, side, rx, 3);
        }
        for (int b = 0; b < w.numBranches; b++) {
            int bs = w.branchAt[b];
            if (bs >= w.segs) continue;
            int bx = sx[bs], by = sy[bs];
            for (int s = 1; s <= BRANCH_SEGS; s++) {
                float sway = sinf(tick * 0.05f + i * 1.20f + (bs + s) * 0.45f) * (bs + s) * 1.5f;
                int nx = w.baseX + (int)sway + w.branchSide[b] * s * 12;
                int ny = by - s * (WEED_SEG_H - 2);
                canvas.drawLine(bx, by, nx, ny, COL_WEED);
                canvas.drawLine(bx + 1, by, nx + 1, ny, COL_WEED);
                int lx = (bx + nx) / 2, ly = (by + ny) / 2 - 1;
                drawLeaf(lx, ly, w.branchSide[b], 4, 2);
                bx = nx; by = ny;
            }
        }
    }
}

void drawFlakePixels(int x, int y, uint8_t shape, uint32_t col) {
    switch (shape) {
        case 0:
            canvas.fillRect(x - 3, y,     7, 1, col);
            canvas.fillRect(x,     y - 3, 1, 7, col);
            break;
        case 1:
            for (int d = -2; d <= 2; d++) { canvas.drawPixel(x + d, y + d, col); canvas.drawPixel(x + d, y - d, col); }
            break;
        default:
            canvas.fillRect(x - 1, y - 1, 3, 3, col);
            break;
    }
}

void drawFlakes() {
    for (int i = 0; i < MAX_FLAKES; i++) {
        if (!flakes[i].active) continue;
        drawFlakePixels((int)flakes[i].x, (int)flakes[i].y, flakes[i].shape, FLAKE_COLS[flakes[i].colorIdx]);
    }
}

void drawFishShadows() {
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        const Fish& f = fish[i];
        if ((f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2 || f.type == FISH_ANGEL) && f.z > 0.78f) continue;
        int sx  = projX(f.x, f.z);
        int fy  = projY(f.y, f.z);
        int tx  = sx < 0 ? 0 : (sx >= SCREEN_W ? SCREEN_W - 1 : sx);
        int gnd = terrainY[tx];
        int dist = gnd - fy;
        if (dist <= 0) continue;
        float scale = 1.0f - (float)dist / 300.0f;
        if (scale < 0.12f) scale = 0.12f;
        int rx = (int)(fishHW(f) * scale), ry = (int)(3 * fishTS(f) * scale);
        if (rx < 1) rx = 1; if (ry < 1) ry = 1;
        canvas.fillEllipse(sx, gnd - 1, rx, ry, 0x4A3010UL);
    }
}

void drawFish() {
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        if ((f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2 || f.type == FISH_ANGEL) && f.z > 0.78f) continue;
        int      ts  = fishTS(f);
        int      sx  = projX(f.x, f.z);
        int      sy  = projY(f.y, f.z);
        int      hw  = fishHW(f);
        uint32_t col = fishColor(i);
        canvas.setTextSize(ts);
        canvas.setTextColor(col);
        if (f.type == FISH_PAIR) {
            canvas.setCursor(sx - hw, sy - 4 * ts);
            canvas.print(f.facingRight ? "><(o>" : "<o(><");
        } else if (f.type == FISH_ANGEL) {
            canvas.setTextSize(1);
            canvas.setCursor(sx - 3, sy - 4 * ts - 8);
            canvas.print(f.facingRight ? "\\" : "/");
            canvas.setTextSize(ts);
            canvas.setCursor(sx - hw, sy - 4 * ts);
            canvas.print(f.facingRight ? "><>" : "<><");
            canvas.setTextSize(1);
            canvas.setCursor(sx - 3, sy + 4 * ts);
            canvas.print(f.facingRight ? "/" : "\\");
        } else {
            canvas.setCursor(sx - hw, sy - 4 * ts);
            canvas.print(f.facingRight ? "><>" : "<><");
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Menu UI
// ═══════════════════════════════════════════════════════════════════════════════

void drawMenuButton() {
    uint32_t bgCol = menuOpen ? 0x2255AAUL : 0x112244UL;
    canvas.fillRect(HBTN_X, HBTN_Y, HBTN_W, HBTN_H, bgCol);
    canvas.drawRect(HBTN_X, HBTN_Y, HBTN_W, HBTN_H, 0x4488CCUL);
    int bx = HBTN_X + 9, bw = HBTN_W - 18;
    canvas.fillRect(bx, HBTN_Y +  8, bw, 3, 0xCCEEFFUL);
    canvas.fillRect(bx, HBTN_Y + 17, bw, 3, 0xCCEEFFUL);
    canvas.fillRect(bx, HBTN_Y + 26, bw, 3, 0xCCEEFFUL);
}

void drawMenu() {
    if (!menuOpen) return;
    canvas.fillRect(MENU_X,   MENU_Y,   MENU_W,   MENU_H,   0x0A1E3CUL);
    canvas.drawRect(MENU_X,   MENU_Y,   MENU_W,   MENU_H,   0x4488CCUL);
    canvas.drawRect(MENU_X+1, MENU_Y+1, MENU_W-2, MENU_H-2, 0x1A3355UL);
    canvas.setTextSize(2); canvas.setTextColor(0x88DDFFUL);
    canvas.setCursor(MENU_X + 28, MENU_Y + 10);
    canvas.print("AQUARIUM MENU");
    canvas.drawFastHLine(MENU_X + 8, MENU_Y + 32, MENU_W - 16, 0x2244AAUL);

    const char* labels[4] = { "LARGE FISH", "SCHOOL FISH", "DEEP FISH", "ANGELFISH" };
    int counts[4]         = { numPair, numSchool, numSchool2, numAngel };
    int maxes[4]          = { MAX_PAIR, MAX_SCHOOL, MAX_SCHOOL2, MAX_ANGEL };
    for (int row = 0; row < 4; row++) {
        int ry = MENU_Y + 45 + row * 58;
        canvas.setTextSize(1); canvas.setTextColor(0xAADDFFUL);
        canvas.setCursor(MENU_X + 10, ry + 11); canvas.print(labels[row]);
        bool canRm = counts[row] > 0;
        canvas.fillRect(MENU_X + 148, ry, 30, 30, canRm ? 0x1A3355UL : 0x0C1A2AUL);
        canvas.drawRect(MENU_X + 148, ry, 30, 30, canRm ? 0x4488CCUL : 0x223344UL);
        canvas.setTextSize(2); canvas.setTextColor(canRm ? 0xFFFFFFUL : 0x334455UL);
        canvas.setCursor(MENU_X + 157, ry + 7); canvas.print("-");
        char buf[4]; snprintf(buf, sizeof(buf), "%d", counts[row]);
        canvas.setTextSize(2); canvas.setTextColor(0xFFEE88UL);
        canvas.setCursor(MENU_X + 184, ry + 7); canvas.print(buf);
        bool canAdd = counts[row] < maxes[row];
        canvas.fillRect(MENU_X + 210, ry, 30, 30, canAdd ? 0x1A3355UL : 0x0C1A2AUL);
        canvas.drawRect(MENU_X + 210, ry, 30, 30, canAdd ? 0x4488CCUL : 0x223344UL);
        canvas.setTextSize(2); canvas.setTextColor(canAdd ? 0xFFFFFFUL : 0x334455UL);
        canvas.setCursor(MENU_X + 217, ry + 7); canvas.print("+");
    }
    {
        int ry5 = MENU_Y + 45 + 5 * 58;
        canvas.setTextSize(1); canvas.setTextColor(0xAADDFFUL);
        canvas.setCursor(MENU_X + 10, ry5 + 11); canvas.print("TIME");
        canvas.fillRect(MENU_X + 110, ry5, 30, 30, 0x1A3355UL);
        canvas.drawRect(MENU_X + 110, ry5, 30, 30, 0x4488CCUL);
        canvas.setTextSize(2); canvas.setTextColor(0xFFFFFFUL);
        canvas.setCursor(MENU_X + 116, ry5 + 7); canvas.print("<");
        const char* tName = (currentTimeMode == TIME_REAL) ? "REAL" : "FAST";
        uint32_t    tCol  = (currentTimeMode == TIME_REAL) ? 0x44FF44UL : 0xFFEE88UL;
        canvas.setTextSize(1); canvas.setTextColor(tCol);
        int tW = (int)strlen(tName) * 6;
        canvas.setCursor(MENU_X + 140 + (78 - tW) / 2, ry5 + 11); canvas.print(tName);
        canvas.fillRect(MENU_X + 218, ry5, 30, 30, 0x1A3355UL);
        canvas.drawRect(MENU_X + 218, ry5, 30, 30, 0x4488CCUL);
        canvas.setTextSize(2); canvas.setTextColor(0xFFFFFFUL);
        canvas.setCursor(MENU_X + 224, ry5 + 7); canvas.print(">");
    }
    {
        int ry4 = MENU_Y + 45 + 4 * 58;
        canvas.setTextSize(1); canvas.setTextColor(0xAADDFFUL);
        canvas.setCursor(MENU_X + 10, ry4 + 11); canvas.print("WEATHER");
        canvas.fillRect(MENU_X + 110, ry4, 30, 30, 0x1A3355UL);
        canvas.drawRect(MENU_X + 110, ry4, 30, 30, 0x4488CCUL);
        canvas.setTextSize(2); canvas.setTextColor(0xFFFFFFUL);
        canvas.setCursor(MENU_X + 116, ry4 + 7); canvas.print("<");
        static const char* wNames[] = { "AUTO","SUNNY","PARTLY CLD","CLOUDY","RAINY","STORMY","SNOWY","FOGGY" };
        int wIdx = (weatherOverrideIdx < 0) ? 0 : (weatherOverrideIdx + 1);
        const char* wName = wNames[wIdx];
        uint32_t wCol = (weatherOverrideIdx < 0) ? 0x44FF44UL : 0xFFEE88UL;
        canvas.setTextSize(1); canvas.setTextColor(wCol);
        int nameW = (int)strlen(wName) * 6;
        int nameX = MENU_X + 140 + (78 - nameW) / 2;
        canvas.setCursor(nameX, ry4 + 11); canvas.print(wName);
        canvas.fillRect(MENU_X + 218, ry4, 30, 30, 0x1A3355UL);
        canvas.drawRect(MENU_X + 218, ry4, 30, 30, 0x4488CCUL);
        canvas.setTextSize(2); canvas.setTextColor(0xFFFFFFUL);
        canvas.setCursor(MENU_X + 224, ry4 + 7); canvas.print(">");
    }
    // Telemetry publish toggle (compact row beneath the time row).
    {
        int ryT = MENU_Y + 45 + 5 * 58 + 38;
        canvas.setTextSize(1); canvas.setTextColor(0xAADDFFUL);
        canvas.setCursor(MENU_X + 10, ryT + 9); canvas.print("TELEMETRY");

        bool on = telemetryEnabled;
        uint32_t boxFill   = on ? 0x115522UL : 0x0C1A2AUL;
        uint32_t boxBorder = on ? 0x33CC66UL : 0x4488CCUL;
        canvas.fillRect(MENU_X + 148, ryT, 28, 28, boxFill);
        canvas.drawRect(MENU_X + 148, ryT, 28, 28, boxBorder);
        if (on) {  // check mark
            canvas.drawLine(MENU_X + 153, ryT + 15, MENU_X + 159, ryT + 21, 0x66FF99UL);
            canvas.drawLine(MENU_X + 159, ryT + 21, MENU_X + 170, ryT + 6,  0x66FF99UL);
        }

        // Status text: ON / OFF, or ERR when posts are failing.
        const char* st  = !on ? "OFF" : (telemetryHasError() ? "ERR" : "ON");
        uint32_t    col = !on ? 0x778899UL : (telemetryHasError() ? 0xFF6655UL : 0x66FF99UL);
        canvas.setTextSize(2); canvas.setTextColor(col);
        canvas.setCursor(MENU_X + 186, ryT + 6); canvas.print(st);
    }
}

// Small failure badge drawn in the tank view when telemetry publishing is on
// but recent POSTs are failing. Blinks to draw attention.
void drawTelemetryStatus() {
    if (!telemetryHasError()) return;
    int x = 10, y = 10;
    bool blink = ((int)tick / 6) % 2 == 0;
    uint32_t dot = blink ? 0xFF4444UL : 0x7A2222UL;
    canvas.fillCircle(x + 6, y + 7, 6, dot);
    canvas.drawCircle(x + 6, y + 7, 6, 0xFFAAAAUL);
    canvas.setTextSize(1); canvas.setTextColor(0xFFBBBBUL);
    canvas.setCursor(x + 18, y + 3); canvas.print("TELEMETRY ERROR");

    // Second line: the actual reason (HTTP code / connection error) + retry count.
    char reason[80];
    telemetryGetError(reason, sizeof(reason));
    char line[96];
    snprintf(line, sizeof(line), "%s  (x%d)",
             reason[0] ? reason : "no response",
             telemetryFailCount.load());
    canvas.setTextColor(0xFFAAAAUL);
    canvas.setCursor(x, y + 18); canvas.print(line);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  loop  (called each iteration from main)
// ═══════════════════════════════════════════════════════════════════════════════
void loop() {
    bool btnState = (BUTTON_PIN >= 0) ? digitalRead(BUTTON_PIN) : HIGH;
    if (btnState == LOW && lastBtnState == HIGH) {
        uint32_t t = millis();
        if (t - lastBtnMs > DEBOUNCE_MS) { lastBtnMs = t; dropFood(); }
    }
    lastBtnState = btnState;

    uint16_t tx = 0, ty = 0;
    bool touched = display.getTouch(&tx, &ty);
    if (touched && !lastTouched) {
        if (tx >= HBTN_X && tx < (uint16_t)(HBTN_X + HBTN_W) &&
            ty >= HBTN_Y && ty < (uint16_t)(HBTN_Y + HBTN_H)) {
            menuOpen = !menuOpen;
        } else if (menuOpen) {
            const FishType rowType[4] = { FISH_PAIR, FISH_SCHOOL, FISH_SCHOOL2, FISH_ANGEL };
            for (int row = 0; row < 4; row++) {
                int ry = MENU_Y + 45 + row * 58;
                if (tx >= (uint16_t)(MENU_X + 148) && tx < (uint16_t)(MENU_X + 178) &&
                    ty >= (uint16_t)ry              && ty < (uint16_t)(ry + 30)) { removeFish(rowType[row]); break; }
                if (tx >= (uint16_t)(MENU_X + 210) && tx < (uint16_t)(MENU_X + 240) &&
                    ty >= (uint16_t)ry              && ty < (uint16_t)(ry + 30)) { addFish(rowType[row]); break; }
            }
            {
                int ry5 = MENU_Y + 45 + 5 * 58;
                if ((tx >= (uint16_t)(MENU_X + 110) && tx < (uint16_t)(MENU_X + 140) &&
                     ty >= (uint16_t)ry5             && ty < (uint16_t)(ry5 + 30)) ||
                    (tx >= (uint16_t)(MENU_X + 218) && tx < (uint16_t)(MENU_X + 248) &&
                     ty >= (uint16_t)ry5             && ty < (uint16_t)(ry5 + 30)))
                    currentTimeMode = (currentTimeMode == TIME_REAL) ? TIME_FAST : TIME_REAL;
            }
            {
                int ry4 = MENU_Y + 45 + 4 * 58;
                if (tx >= (uint16_t)(MENU_X + 110) && tx < (uint16_t)(MENU_X + 140) &&
                    ty >= (uint16_t)ry4             && ty < (uint16_t)(ry4 + 30)) {
                    weatherOverrideIdx--;
                    if (weatherOverrideIdx < -1) weatherOverrideIdx = 6;
                    if (weatherOverrideIdx >= 0) { currentWeather = (WeatherCondition)weatherOverrideIdx; initWeatherEffects(); }
                    else forceWeatherRefetch();
                }
                if (tx >= (uint16_t)(MENU_X + 218) && tx < (uint16_t)(MENU_X + 248) &&
                    ty >= (uint16_t)ry4             && ty < (uint16_t)(ry4 + 30)) {
                    weatherOverrideIdx++;
                    if (weatherOverrideIdx > 6) weatherOverrideIdx = -1;
                    if (weatherOverrideIdx >= 0) { currentWeather = (WeatherCondition)weatherOverrideIdx; initWeatherEffects(); }
                    else forceWeatherRefetch();
                }
            }
            {
                int ryT = MENU_Y + 45 + 5 * 58 + 38;
                if (tx >= (uint16_t)(MENU_X + 148) && tx < (uint16_t)(MENU_X + 230) &&
                    ty >= (uint16_t)ryT             && ty < (uint16_t)(ryT + 28)) {
                    telemetryEnabled = !telemetryEnabled;
                    if (telemetryEnabled) {   // start clean — clear any stale error
                        telemetryEverTried = false;
                        telemetryLastOk    = true;
                    }
                }
            }
        } else if ((int)ty > TANK_TOP) {
            dropFood((int)tx, (int)ty);
        }
    }
    lastTouched = touched;

    uint32_t now = millis();
    if (now - lastFrameMs < FRAME_MS) return;
    lastFrameMs = now;
    tick += 1.0f;

    if (weatherOverrideIdx < 0) {
        WeatherCondition prevW = currentWeather;
        updateWeather();
        if (currentWeather != prevW) initWeatherEffects();
    }
    updateWeatherEffects();
    telemetryUpdate();
    updateBoat();
    updateSnail();
    updateStarfish();
    updateBubbles();
    updateFlakes();
    updateFish();

    drawBackground();
    drawWeatherSky();
    drawBoat();
    drawBgPlants();
    drawFishShadows();
    drawSnail();
    drawStarfish();
    drawSeaweed();
    drawFgHornwort();
    drawBubbles();
    drawFlakes();
    drawFish();
    drawTankRim();
    drawTelemetryStatus();
    drawMenuButton();
    drawMenu();
    canvas.pushSprite(0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════════════════════════════════════
int main(int /*argc*/, char* /*argv*/[]) {
    setup();

    bool running = true;
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            switch (ev.type) {
                case SDL_QUIT:
                    running = false;
                    break;
                case SDL_MOUSEBUTTONDOWN:
                    if (ev.button.button == SDL_BUTTON_LEFT) {
                        display._touched = true;
                        display._touchX  = ev.button.x;
                        display._touchY  = ev.button.y;
                    }
                    break;
                case SDL_MOUSEBUTTONUP:
                    if (ev.button.button == SDL_BUTTON_LEFT)
                        display._touched = false;
                    break;
                case SDL_MOUSEMOTION:
                    if (ev.motion.state & SDL_BUTTON_LMASK) {
                        display._touchX = ev.motion.x;
                        display._touchY = ev.motion.y;
                    }
                    break;
                // Native Pi touchscreen events
                case SDL_FINGERDOWN:
                    display._touched = true;
                    display._touchX  = (int)(ev.tfinger.x * SCREEN_W);
                    display._touchY  = (int)(ev.tfinger.y * SCREEN_H);
                    break;
                case SDL_FINGERMOTION:
                    display._touchX = (int)(ev.tfinger.x * SCREEN_W);
                    display._touchY = (int)(ev.tfinger.y * SCREEN_H);
                    break;
                case SDL_FINGERUP:
                    display._touched = false;
                    break;
                case SDL_KEYDOWN:
                    if (ev.key.keysym.sym == SDLK_ESCAPE)
                        running = false;
                    else if (ev.key.keysym.sym == SDLK_SPACE)
                        dropFood();
                    break;
            }
        }
        loop();
        SDL_Delay(1);  // yield when frames aren't due
    }

    TTF_Quit();
    SDL_Quit();
    curl_global_cleanup();
    return 0;
}

/*
 * ASCII Aquarium
 * Hardware : Elecrow CrowPanel 7.0" HMI (ESP32-S3-WROOM-1-N4R8, 800×480 RGB)
 * Library  : LovyanGFX
 *
 * Feed button: GPIO0 (onboard boot button) — active LOW, internal pull-up.
 */

#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>

#include "version.h"
#include "wifi_config.h"

// ═══════════════════════════════════════════════════════════════════════════════
//  LGFX — Elecrow CrowPanel 7.0" (16-bit parallel RGB, GT911 touch)
// ═══════════════════════════════════════════════════════════════════════════════
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_RGB    _rgb_panel;
  lgfx::Bus_RGB      _rgb_bus;
  lgfx::Light_PWM    _rgb_light;
  lgfx::Touch_GT911  _rgb_touch;

public:
  LGFX() {
    { // ── RGB parallel bus ─────────────────────────────────────────────────
      auto cfg = _rgb_bus.config();
      cfg.panel = &_rgb_panel;

      cfg.pin_d0  = GPIO_NUM_15; // B0
      cfg.pin_d1  = GPIO_NUM_7;  // B1
      cfg.pin_d2  = GPIO_NUM_6;  // B2
      cfg.pin_d3  = GPIO_NUM_5;  // B3
      cfg.pin_d4  = GPIO_NUM_4;  // B4
      cfg.pin_d5  = GPIO_NUM_9;  // G0
      cfg.pin_d6  = GPIO_NUM_46; // G1
      cfg.pin_d7  = GPIO_NUM_3;  // G2
      cfg.pin_d8  = GPIO_NUM_8;  // G3
      cfg.pin_d9  = GPIO_NUM_16; // G4
      cfg.pin_d10 = GPIO_NUM_1;  // G5
      cfg.pin_d11 = GPIO_NUM_14; // R0
      cfg.pin_d12 = GPIO_NUM_21; // R1
      cfg.pin_d13 = GPIO_NUM_47; // R2
      cfg.pin_d14 = GPIO_NUM_48; // R3
      cfg.pin_d15 = GPIO_NUM_45; // R4

      cfg.pin_henable = GPIO_NUM_41;
      cfg.pin_vsync   = GPIO_NUM_40;
      cfg.pin_hsync   = GPIO_NUM_39;
      cfg.pin_pclk    = GPIO_NUM_0;
      cfg.freq_write  = 12000000;

      cfg.hsync_polarity    = 0;
      cfg.hsync_front_porch = 40;
      cfg.hsync_pulse_width = 48;
      cfg.hsync_back_porch  = 40;
      cfg.vsync_polarity    = 0;
      cfg.vsync_front_porch = 1;
      cfg.vsync_pulse_width = 31;
      cfg.vsync_back_porch  = 13;
      cfg.pclk_active_neg   = 1;
      cfg.de_idle_high      = 0;
      cfg.pclk_idle_high    = 0;

      _rgb_bus.config(cfg);
    }
    { // ── Panel ─────────────────────────────────────────────────────────────
      auto cfg          = _rgb_panel.config();
      cfg.memory_width  = 800;
      cfg.memory_height = 480;
      cfg.panel_width   = 800;
      cfg.panel_height  = 480;
      cfg.offset_x      = 0;
      cfg.offset_y      = 0;
      _rgb_panel.config(cfg);

      auto cfg_detail        = _rgb_panel.config_detail();
      cfg_detail.use_psram   = 2;
      _rgb_panel.config_detail(cfg_detail);
    }
    { // ── Backlight (GPIO2) ─────────────────────────────────────────────────
      auto cfg        = _rgb_light.config();
      cfg.pin_bl      = GPIO_NUM_2;
      cfg.invert      = false;
      cfg.freq        = 44100;
      cfg.pwm_channel = 7;
      _rgb_light.config(cfg);
      _rgb_panel.setLight(&_rgb_light);
    }
    { // ── Touch — GT911 via I²C ─────────────────────────────────────────────
      auto cfg             = _rgb_touch.config();
      cfg.x_min            = 0;
      cfg.x_max            = 799;
      cfg.y_min            = 0;
      cfg.y_max            = 479;
      cfg.pin_int          = -1;
      cfg.pin_rst          = -1;
      cfg.bus_shared       = false;
      cfg.offset_rotation  = 0;
      cfg.i2c_port         = 1;
      cfg.i2c_addr         = 0x14;
      cfg.pin_sda          = GPIO_NUM_19;
      cfg.pin_scl          = GPIO_NUM_20;
      cfg.freq             = 400000;
      _rgb_touch.config(cfg);
      _rgb_panel.setTouch(&_rgb_touch);
    }
    _rgb_panel.setBus(&_rgb_bus);
    setPanel(&_rgb_panel);
  }
};

static LGFX          display;
static LGFX_Sprite    canvas(&display);

#include "ota_update.h"

// ─── Screen ──────────────────────────────────────────────────────────────────
#define SCREEN_W  800
#define SCREEN_H  480
#define TANK_TOP   72   // water surface row; 15% of SCREEN_H is outside the tank

static int16_t terrainY[SCREEN_W];

// ─── Button ──────────────────────────────────────────────────────────────────
#define BUTTON_PIN   -1
#define DEBOUNCE_MS  300

// ─── Timing ──────────────────────────────────────────────────────────────────
#define FRAME_MS  50
uint32_t lastFrameMs = 0;
float    tick        = 0;

// ─── Colours (24-bit RGB) ────────────────────────────────────────────────────
#define COL_BG      0x003060UL
#define COL_SAND    0xC8A050UL
#define COL_BUBBLE  0x55CCFFUL
#define COL_WEED      0x00AA44UL
#define COL_WEED_LEAF 0x33DD66UL

// Pair fish — 8 colour slots (wraps for extra fish)
const uint32_t PAIR_COLS[8] = {
  0x00EE66UL, 0xFFDD00UL, 0xFF6600UL, 0xCC44FFUL,
  0x44DDFFUL, 0xFF44AAUL, 0x88FF44UL, 0xFFAA22UL,
};

// School 1 — 16 colour slots
const uint32_t SCHOOL_COLS[16] = {
  0x00FFFFUL, 0xFF66FFUL, 0xFF8800UL, 0x88FFDDUL,
  0xCCFF44UL, 0x22DDBBUL, 0xFFBB55UL, 0xBB88FFUL,
  0x44FFEEUL, 0xFF44CCUL, 0x99FF22UL, 0xFF9966UL,
  0x6688FFUL, 0xFFEE22UL, 0x22FFAAUL, 0xEE88FFUL,
};

// School 2 — 20 colour slots
const uint32_t SCHOOL2_COLS[20] = {
  0xFF4400UL, 0xFF9900UL, 0xFFCC00UL, 0xFF6688UL,
  0xDD2255UL, 0xFF88BBUL, 0xFFAAFFUL, 0xFFFF66UL,
  0x77FFAAUL, 0xCCAA88UL, 0xFF3300UL, 0xFFBB00UL,
  0xFF55AAUL, 0xEE1144UL, 0xFF99CCUL, 0xFFDD88UL,
  0x99FF77UL, 0xDDBB99UL, 0xFF6600UL, 0xFFCC55UL,
};

// Rainbow flake colours
const uint32_t FLAKE_COLS[7] = {
  0xFF2020UL, 0xFF8800UL, 0xFFFF00UL, 0x00FF44UL,
  0x00AAFFUL, 0x9944FFUL, 0xFF00CCUL,
};

// ─── Bubbles ─────────────────────────────────────────────────────────────────
#define NUM_BUBBLES 20
struct Bubble {
  float   x, y, spd;
  uint8_t r;
};
Bubble bubbles[NUM_BUBBLES];

// ─── Seaweed ─────────────────────────────────────────────────────────────────
#define NUM_WEEDS     8
#define WEED_SEG_H   14
#define BRANCH_SEGS   3

struct Seaweed {
  uint16_t baseX;
  uint8_t  segs;
  uint8_t  numBranches;
  uint8_t  branchAt[2];
  int8_t   branchSide[2];
};
Seaweed weeds[NUM_WEEDS];

// ─── Snail ───────────────────────────────────────────────────────────────────
struct Snail {
  float x;
  float spd;
  bool  facingRight;
};
static Snail snail;

// ─── Food flakes ─────────────────────────────────────────────────────────────
#define MAX_FLAKES 10
struct Flake {
  float   x, y, spd;
  bool    active;
  uint8_t shape;
  uint8_t colorIdx;
};
Flake flakes[MAX_FLAKES];

// ─── Fish ────────────────────────────────────────────────────────────────────
enum FishType : uint8_t { FISH_PAIR, FISH_SCHOOL, FISH_SCHOOL2 };

struct Fish {
  float    x, y, z;
  float    vx, vy, vz;
  float    tx, ty, tz;
  float    wanderCD;
  bool     facingRight;
  FishType type;
  int8_t   partner;
  bool     goingForFood;
  int8_t   targetFlake;
  bool     chasing;
  float    fullTimer;
};

// Fixed-slot layout: [0..MAX_PAIR-1] pair, [MAX_PAIR..MAX_PAIR+MAX_SCHOOL-1] school1,
// [MAX_PAIR+MAX_SCHOOL..MAX_FISH-1] school2.  Only the first num* slots are active.
#define MAX_PAIR    8
#define MAX_SCHOOL  16
#define MAX_SCHOOL2 20
#define MAX_FISH    (MAX_PAIR + MAX_SCHOOL + MAX_SCHOOL2)

static int numPair    = 2;
static int numSchool  = 5;
static int numSchool2 = 7;

Fish fish[MAX_FISH];

// ─── Menu ─────────────────────────────────────────────────────────────────────
#define HBTN_X   748
#define HBTN_Y     5
#define HBTN_W    47
#define HBTN_H    38

#define MENU_X   510
#define MENU_Y    48
#define MENU_W   282
#define MENU_H   230

// ─── Button / touch state ─────────────────────────────────────────────────────
bool     lastBtnState  = HIGH;
uint32_t lastBtnMs     = 0;
bool     lastTouched   = false;
bool     menuOpen      = false;

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

float frand()                    { return random(0, 1000) * 0.001f; }
float frandr(float lo, float hi) { return lo + frand() * (hi - lo); }

inline bool isFishActive(int i) {
  if (i < MAX_PAIR)              return i < numPair;
  if (i < MAX_PAIR + MAX_SCHOOL) return (i - MAX_PAIR) < numSchool;
  return (i - MAX_PAIR - MAX_SCHOOL) < numSchool2;
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

int fishHW(const Fish& f) {
  int ts    = fishTS(f);
  int chars = (f.type == FISH_PAIR) ? 5 : 3;
  return (chars * 6 * ts) / 2;
}

uint32_t fishColor(int idx) {
  if (idx < MAX_PAIR)                  return PAIR_COLS[idx % 8];
  if (idx < MAX_PAIR + MAX_SCHOOL)     return SCHOOL_COLS[(idx - MAX_PAIR) % 16];
  return SCHOOL2_COLS[(idx - MAX_PAIR - MAX_SCHOOL) % 20];
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

void initFishEntry(int idx,
                   float x, float y, float z, float vx,
                   FishType type, int8_t partner) {
  Fish& f      = fish[idx];
  f.x = f.tx  = x;
  f.y = f.ty  = y;
  f.z = f.tz  = z;
  f.vx         = vx;
  f.vy         = 0;
  f.vz         = 0;
  f.wanderCD   = frandr(40, 130);
  f.facingRight = (vx >= 0);
  f.type        = type;
  f.partner     = partner;
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
    if (idx % 2 == 1) {
      partner = idx - 1;
      fish[idx - 1].partner = idx;
    }
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
  }
}

void removeFish(FishType type) {
  if (type == FISH_PAIR && numPair > 0) {
    int idx = numPair - 1;
    if (idx % 2 == 1) fish[idx - 1].partner = -1;
    numPair--;
  } else if (type == FISH_SCHOOL && numSchool > 0) {
    numSchool--;
  } else if (type == FISH_SCHOOL2 && numSchool2 > 0) {
    numSchool2--;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  setup
// ═══════════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  randomSeed(analogRead(36));
  if (BUTTON_PIN >= 0) pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.printf("Total PSRAM : %u bytes\n", ESP.getPsramSize());
  Serial.printf("Free  PSRAM : %u bytes\n", ESP.getFreePsram());

  void* testAlloc = heap_caps_malloc(800 * 480 * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  Serial.printf("768 KB PSRAM alloc test : %s\n", testAlloc ? "OK" : "FAILED");
  if (testAlloc) heap_caps_free(testAlloc);

  Serial.println("Calling display.init()...");
  bool initOk = display.init();
  Serial.printf("display.init() returned : %s\n", initOk ? "true" : "false");
  Serial.printf("display W=%d  H=%d\n", display.width(), display.height());
  display.setBrightness(255);
  display.setRotation(0);
  display.fillScreen(0x000000UL);

  checkForOTAUpdate();

  for (int x = 0; x < SCREEN_W; x++) {
    float h = sinf(x * 0.018f) * 4.0f
            + sinf(x * 0.063f) * 2.5f
            + sinf(x * 0.140f) * 1.5f;
    terrainY[x] = (int16_t)(SCREEN_H - 18 + (int)h);
  }

  canvas.setPsram(true);
  if (!canvas.createSprite(SCREEN_W, SCREEN_H)) {
    Serial.println("ERROR: canvas sprite allocation failed");
  } else {
    Serial.println("Canvas sprite created OK");
  }

  for (int i = 0; i < NUM_BUBBLES; i++) resetBubble(i, true);

  for (int i = 0; i < NUM_WEEDS; i++) {
    weeds[i].baseX       = (uint16_t)(40 + i * (SCREEN_W / (NUM_WEEDS + 1)));
    weeds[i].segs        = (uint8_t)(8 + random(0, 7));
    weeds[i].numBranches = (uint8_t)(1 + random(0, 2));
    for (int b = 0; b < 2; b++) {
      weeds[i].branchAt[b]   = (uint8_t)(2 + random(0, weeds[i].segs - 3));
      weeds[i].branchSide[b] = (random(0, 2) == 0) ? 1 : -1;
    }
  }

  // Pair fish — indices 0 and 1
  initFishEntry(0,  150, 210, 0.20f,  3.0f, FISH_PAIR, 1);
  initFishEntry(1,  330, 240, 0.35f, -2.5f, FISH_PAIR, 0);

  // School 1 — starts at index MAX_PAIR
  for (int i = 0; i < numSchool; i++) {
    initFishEntry(MAX_PAIR + i,
                  frandr(380, 620), frandr(130, 330), frandr(0.40f, 0.75f),
                  frandr(-2.0f, 2.0f), FISH_SCHOOL, -1);
  }

  // School 2 — starts at index MAX_PAIR + MAX_SCHOOL
  for (int i = 0; i < numSchool2; i++) {
    initFishEntry(MAX_PAIR + MAX_SCHOOL + i,
                  frandr(150, 400), frandr(150, 350), frandr(0.40f, 0.75f),
                  frandr(-2.0f, 2.0f), FISH_SCHOOL2, -1);
  }

  for (int i = 0; i < MAX_FLAKES; i++) flakes[i].active = false;

  snail.x           = frandr(80, SCREEN_W - 80);
  snail.spd         = frandr(0.12f, 0.25f);
  snail.facingRight = (random(0, 2) == 0);

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
//  Update — snail / bubbles / flakes
// ═══════════════════════════════════════════════════════════════════════════════
void updateSnail() {
  float move = snail.facingRight ? snail.spd : -snail.spd;
  snail.x += move;
  if (snail.x > SCREEN_W - 55) { snail.x = SCREEN_W - 55; snail.facingRight = false; }
  if (snail.x < 55)             { snail.x = 55;             snail.facingRight = true;  }
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
  int   best = -1;
  float bd   = 1e9f;
  for (int i = 0; i < MAX_FLAKES; i++) {
    if (!flakes[i].active) continue;
    float dx = flakes[i].x - f.x, dy = flakes[i].y - f.y;
    float d  = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

void updateFish() {
  // School 1 centroid
  float scx = 0, scy = 0, scz = 0;
  if (numSchool > 0) {
    for (int i = MAX_PAIR; i < MAX_PAIR + numSchool; i++) {
      scx += fish[i].x; scy += fish[i].y; scz += fish[i].z;
    }
    scx /= numSchool; scy /= numSchool; scz /= numSchool;
  }

  // School 2 centroid
  float sc2x = 0, sc2y = 0, sc2z = 0;
  if (numSchool2 > 0) {
    for (int i = MAX_PAIR + MAX_SCHOOL; i < MAX_PAIR + MAX_SCHOOL + numSchool2; i++) {
      sc2x += fish[i].x; sc2y += fish[i].y; sc2z += fish[i].z;
    }
    sc2x /= numSchool2; sc2y /= numSchool2; sc2z /= numSchool2;
  }

  for (int i = 0; i < MAX_FISH; i++) {
    if (!isFishActive(i)) continue;
    Fish& f = fish[i];
    float ax = 0, ay = 0, az = 0;

    // ── Satiety timer ────────────────────────────────────────────────────────
    if (f.fullTimer > 0) {
      f.fullTimer -= 1.0f;
      if (f.fullTimer <= 0) f.fullTimer = 0;
    }

    // ── Chase food ───────────────────────────────────────────────────────────
    if (f.goingForFood && f.fullTimer <= 0) {
      if (!anyFlakeActive()) {
        f.goingForFood = false;
        f.targetFlake  = -1;
      } else {
        if (f.targetFlake < 0 || !flakes[f.targetFlake].active)
          f.targetFlake = nearestFlake(f);

        if (f.targetFlake >= 0) {
          if (f.z > 0.25f) {
            az += (0.15f - f.z) * 0.06f;
          } else {
            ax += (flakes[f.targetFlake].x - f.x) * 0.05f;
            ay += (flakes[f.targetFlake].y - f.y) * 0.05f;
          }
        }
      }
    }

    // ── Wander / flock ───────────────────────────────────────────────────────
    else {
      f.wanderCD -= 1.0f;
      if (f.wanderCD <= 0.0f) {
        if (f.type == FISH_PAIR) {
          f.chasing  = !f.chasing;
          f.wanderCD = f.chasing ? frandr(30, 70) : frandr(40, 90);
        } else {
          f.wanderCD = frandr(15, 50);
        }

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
          // Solo pair fish — wander freely
          f.tx = frandr(30.0f, (float)(SCREEN_W - 30));
          f.ty = frandr((float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
          f.tz = constrain(f.tz + frandr(-0.12f, 0.12f), 0.05f, 0.72f);
        } else if (f.type == FISH_SCHOOL) {
          f.tx = constrain(scx + frandr(-160, 160), 30.0f, (float)(SCREEN_W - 30));
          f.ty = constrain(scy + frandr(-90,   90), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
          f.tz = constrain(scz + frandr(-0.15f, 0.15f), 0.05f, 0.72f);
        } else {
          f.tx = constrain(sc2x + frandr(-160, 160), 30.0f, (float)(SCREEN_W - 30));
          f.ty = constrain(sc2y + frandr(-90,   90), (float)(TANK_TOP + 20), (float)(SCREEN_H - 80));
          f.tz = constrain(sc2z + frandr(-0.15f, 0.15f), 0.05f, 0.72f);
        }
      }

      float seekStr = (f.type == FISH_PAIR && f.chasing) ? 0.018f : 0.012f;
      ax += (f.tx - f.x) * seekStr;
      ay += (f.ty - f.y) * seekStr;
      az += (f.tz - f.z) * 0.010f;

      if (f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2) {
        float cx = (f.type == FISH_SCHOOL) ? scx  : sc2x;
        float cy = (f.type == FISH_SCHOOL) ? scy  : sc2y;
        float cz = (f.type == FISH_SCHOOL) ? scz  : sc2z;
        int   js = (f.type == FISH_SCHOOL) ? MAX_PAIR : (MAX_PAIR + MAX_SCHOOL);
        int   je = (f.type == FISH_SCHOOL) ? (MAX_PAIR + numSchool)
                                           : (MAX_PAIR + MAX_SCHOOL + numSchool2);

        ax += (cx - f.x) * 0.010f;
        ay += (cy - f.y) * 0.007f;
        az += (cz - f.z) * 0.007f;

        for (int j = js; j < je; j++) {
          if (j == i || !isFishActive(j)) continue;
          float dx = f.x - fish[j].x, dy = f.y - fish[j].y;
          float d2 = dx * dx + dy * dy;
          if (d2 < 80.0f * 80.0f && d2 > 0.01f) {
            float inv = 8.0f / d2;
            ax += dx * inv; ay += dy * inv;
          }
        }
      }
    }

    ax += boundAccel(f.x,  30,                SCREEN_W - 30);
    ay += boundAccel(f.y,  TANK_TOP + 20,    SCREEN_H - 80);
    az += boundAccel(f.z,  0.0f,     0.75f, 0.08f);

    float maxV  = f.goingForFood ? 8.0f
                : (f.type == FISH_PAIR && f.chasing) ? 7.0f
                : 5.5f;
    float maxVz = 0.015f;
    f.vx = constrain(f.vx + ax, -maxV,       maxV);
    f.vy = constrain(f.vy + ay, -maxV * 0.5f, maxV * 0.5f);
    f.vz = constrain(f.vz + az, -maxVz,      maxVz);

    f.vx *= 0.85f; f.vy *= 0.85f; f.vz *= 0.88f;

    f.x += f.vx; f.y += f.vy; f.z += f.vz;
    f.x = constrain(f.x, 5.0f,               (float)(SCREEN_W - 5));
    f.y = constrain(f.y, (float)(TANK_TOP + 5), (float)(SCREEN_H - 60));
    f.z = constrain(f.z, 0.0f, 0.78f);

    if (fabsf(f.vx) > 0.4f) f.facingRight = (f.vx > 0);

    // ── Mouth–flake collision ────────────────────────────────────────────────
    if (f.goingForFood && f.targetFlake >= 0 && flakes[f.targetFlake].active) {
      int sx     = projX(f.x, f.z);
      int sy     = projY(f.y, f.z);
      int hw     = fishHW(f);
      int ts     = fishTS(f);
      int mouthX = f.facingRight ? (sx + hw) : (sx - hw);
      int flkX   = (int)flakes[f.targetFlake].x;
      int flkY   = (int)flakes[f.targetFlake].y;
      int hitR   = 10 + ts * 4;

      if (abs(mouthX - flkX) < hitR && abs(sy - flkY) < hitR) {
        flakes[f.targetFlake].active = false;
        f.goingForFood = false;
        f.targetFlake  = -1;
        f.fullTimer    = 30 * 20;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Draw helpers
// ═══════════════════════════════════════════════════════════════════════════════

void drawSnail() {
  int   bx = (int)snail.x;
  int   by = terrainY[constrain(bx, 0, SCREEN_W - 1)];
  int   d  = snail.facingRight ? 1 : -1;

  const uint32_t BODY  = 0xDDB060UL;
  const uint32_t SHELL = 0x7A2E0AUL;
  const uint32_t SWIRL = 0xB05020UL;

  canvas.fillCircle(bx - d * 4, by - 8, 8, SHELL);
  canvas.drawCircle(bx - d * 3, by - 8, 5, SWIRL);
  canvas.drawCircle(bx - d * 2, by - 8, 2, SWIRL);
  canvas.drawPixel (bx - d * 2, by - 8,    BODY);
  canvas.fillEllipse(bx, by - 3, 12, 3, BODY);
  canvas.fillCircle(bx + d * 10, by - 5, 5, BODY);
  canvas.drawLine(bx + d * 8,  by - 9,  bx + d * 6,  by - 15, BODY);
  canvas.drawLine(bx + d * 12, by - 9,  bx + d * 14, by - 15, BODY);
  canvas.fillCircle(bx + d * 6,  by - 15, 2, BODY);
  canvas.fillCircle(bx + d * 14, by - 15, 2, BODY);
  canvas.fillCircle(bx + d * 6,  by - 15, 1, 0x111111UL);
  canvas.fillCircle(bx + d * 14, by - 15, 1, 0x111111UL);
}

void drawBackground() {
  // Bright orange outside area + version label — diagnostic to confirm firmware
  // version and that TANK_TOP is active. Will be styled once confirmed working.
  canvas.fillRect(0, 0, SCREEN_W, TANK_TOP, 0xFF6600UL);
  canvas.setTextColor(0xFFFFFFUL);
  canvas.setTextSize(2);
  canvas.setCursor(6, (TANK_TOP - 16) / 2);
  canvas.print("v" FIRMWARE_VERSION);

  // Flat uniform water — single colour, no spatial variation (no streaks/rays).
  // The colour pulses very gently over time so the water still feels alive.
  float w = sinf(tick * 0.050f) * 9.0f + sinf(tick * 0.022f) * 5.0f;
  int g = constrain(0x30 + (int)(w * 0.35f), 0, 255);
  int b = constrain(0x60 + (int)w,            0, 255);
  canvas.fillRect(0, TANK_TOP, SCREEN_W, SCREEN_H - TANK_TOP,
                  ((uint32_t)g << 8) | (uint32_t)b);

  // Sand floor
  for (int x = 0; x < SCREEN_W; x++) {
    canvas.drawFastVLine(x, terrainY[x], SCREEN_H - terrainY[x], COL_SAND);
  }
}

void drawTankRim() {
  // Drawn after fish/bubbles so it clips anything that reaches the surface.
  // Total rim height: 22px, sitting at TANK_TOP-22 .. TANK_TOP+4

  // ── Outer frame (thick dark metal strip) ─────────────────────────────────
  canvas.fillRect(0, TANK_TOP - 22, SCREEN_W, 12, 0x484848UL); // frame body
  canvas.fillRect(0, TANK_TOP - 22, SCREEN_W,  1, 0xB0B0B0UL); // top shine
  canvas.fillRect(0, TANK_TOP - 11, SCREEN_W,  1, 0x202020UL); // bottom shadow

  // ── Glass panel ───────────────────────────────────────────────────────────
  canvas.fillRect(0, TANK_TOP - 10, SCREEN_W,  9, 0x2E6888UL); // glass body
  canvas.fillRect(0, TANK_TOP - 10, SCREEN_W,  2, 0xAADDEEUL); // bright top edge
  canvas.fillRect(0, TANK_TOP -  4, SCREEN_W,  2, 0x5098B8UL); // mid reflection
  canvas.fillRect(0, TANK_TOP -  2, SCREEN_W,  1, 0x88CCDDUL); // lower highlight
  canvas.fillRect(0, TANK_TOP -  1, SCREEN_W,  1, 0xDDEEFFUL); // bright waterline lip

  // ── Shadow just inside the water ─────────────────────────────────────────
  canvas.fillRect(0, TANK_TOP,      SCREEN_W,  4, 0x061018UL);
}

void drawBubbles() {
  for (int i = 0; i < NUM_BUBBLES; i++) {
    int bx = (int)bubbles[i].x, by = (int)bubbles[i].y;
    canvas.drawCircle(bx, by, bubbles[i].r,     COL_BUBBLE);
    canvas.drawCircle(bx, by, bubbles[i].r - 1, COL_BUBBLE);
  }
}

static void drawLeaf(int cx, int cy, int side, int rx, int ry) {
  int lx = cx + side * (rx + 2);
  canvas.fillEllipse(lx, cy, rx, ry, COL_WEED_LEAF);
  canvas.drawLine(cx, cy, lx, cy, COL_WEED);
}

void drawSeaweed() {
  for (int i = 0; i < NUM_WEEDS; i++) {
    Seaweed& w = weeds[i];

    int sx[15], sy[15];
    sx[0] = w.baseX;
    sy[0] = SCREEN_H - 20;
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
      int lx = (sx[s-1] + sx[s]) / 2;
      int ly = (sy[s-1] + sy[s]) / 2 - 2;
      int side = (s % 2 == 0) ? 1 : -1;
      int rx = 5 + (s % 3);
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

        int lx = (bx + nx) / 2;
        int ly = (by + ny) / 2 - 1;
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
      for (int d = -2; d <= 2; d++) {
        canvas.drawPixel(x + d, y + d, col);
        canvas.drawPixel(x + d, y - d, col);
      }
      break;
    default:
      canvas.fillRect(x - 1, y - 1, 3, 3, col);
      break;
  }
}

void drawFlakes() {
  for (int i = 0; i < MAX_FLAKES; i++) {
    if (!flakes[i].active) continue;
    drawFlakePixels((int)flakes[i].x, (int)flakes[i].y,
                    flakes[i].shape, FLAKE_COLS[flakes[i].colorIdx]);
  }
}

void drawFishShadows() {
  for (int i = 0; i < MAX_FISH; i++) {
    if (!isFishActive(i)) continue;
    const Fish& f = fish[i];
    if ((f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2) && f.z > 0.78f) continue;

    int sx  = projX(f.x, f.z);
    int fy  = projY(f.y, f.z);
    int tx  = sx < 0 ? 0 : (sx >= SCREEN_W ? SCREEN_W - 1 : sx);
    int gnd = terrainY[tx];

    int dist = gnd - fy;
    if (dist <= 0) continue;

    float scale = 1.0f - (float)dist / 300.0f;
    if (scale < 0.12f) scale = 0.12f;

    int rx = (int)(fishHW(f) * scale);
    int ry = (int)(3 * fishTS(f) * scale);
    if (rx < 1) rx = 1;
    if (ry < 1) ry = 1;

    canvas.fillEllipse(sx, gnd - 1, rx, ry, 0x4A3010UL);
  }
}

void drawFish() {
  for (int i = 0; i < MAX_FISH; i++) {
    if (!isFishActive(i)) continue;
    Fish& f = fish[i];
    if ((f.type == FISH_SCHOOL || f.type == FISH_SCHOOL2) && f.z > 0.78f) continue;

    int      ts  = fishTS(f);
    int      sx  = projX(f.x, f.z);
    int      sy  = projY(f.y, f.z);
    int      hw  = fishHW(f);
    uint32_t col = fishColor(i);

    canvas.setTextSize(ts);
    canvas.setTextColor(col);
    canvas.setCursor(sx - hw, sy - 4 * ts);

    if (f.type == FISH_PAIR) {
      canvas.print(f.facingRight ? "><(o>" : "<o(><");
    } else {
      canvas.print(f.facingRight ? "><>"   : "<><");
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
  int bx = HBTN_X + 9;
  int bw = HBTN_W - 18;
  canvas.fillRect(bx, HBTN_Y +  8, bw, 3, 0xCCEEFFUL);
  canvas.fillRect(bx, HBTN_Y + 17, bw, 3, 0xCCEEFFUL);
  canvas.fillRect(bx, HBTN_Y + 26, bw, 3, 0xCCEEFFUL);
}

void drawMenu() {
  if (!menuOpen) return;

  canvas.fillRect(MENU_X,   MENU_Y,   MENU_W,   MENU_H,   0x0A1E3CUL);
  canvas.drawRect(MENU_X,   MENU_Y,   MENU_W,   MENU_H,   0x4488CCUL);
  canvas.drawRect(MENU_X+1, MENU_Y+1, MENU_W-2, MENU_H-2, 0x1A3355UL);

  canvas.setTextSize(2);
  canvas.setTextColor(0x88DDFFUL);
  canvas.setCursor(MENU_X + 28, MENU_Y + 10);
  canvas.print("AQUARIUM MENU");

  canvas.drawFastHLine(MENU_X + 8, MENU_Y + 32, MENU_W - 16, 0x2244AAUL);

  const char* labels[3] = { "LARGE FISH", "SCHOOL FISH", "DEEP FISH" };
  int counts[3]         = { numPair, numSchool, numSchool2 };
  int maxes[3]          = { MAX_PAIR, MAX_SCHOOL, MAX_SCHOOL2 };

  for (int row = 0; row < 3; row++) {
    int ry = MENU_Y + 45 + row * 58;

    canvas.setTextSize(1);
    canvas.setTextColor(0xAADDFFUL);
    canvas.setCursor(MENU_X + 10, ry + 11);
    canvas.print(labels[row]);

    // [-] button
    bool canRm = counts[row] > 0;
    canvas.fillRect(MENU_X + 148, ry, 30, 30, canRm ? 0x1A3355UL : 0x0C1A2AUL);
    canvas.drawRect(MENU_X + 148, ry, 30, 30, canRm ? 0x4488CCUL : 0x223344UL);
    canvas.setTextSize(2);
    canvas.setTextColor(canRm ? 0xFFFFFFUL : 0x334455UL);
    canvas.setCursor(MENU_X + 157, ry + 7);
    canvas.print("-");

    // Count
    char buf[4];
    snprintf(buf, sizeof(buf), "%d", counts[row]);
    canvas.setTextSize(2);
    canvas.setTextColor(0xFFEE88UL);
    canvas.setCursor(MENU_X + 184, ry + 7);
    canvas.print(buf);

    // [+] button
    bool canAdd = counts[row] < maxes[row];
    canvas.fillRect(MENU_X + 210, ry, 30, 30, canAdd ? 0x1A3355UL : 0x0C1A2AUL);
    canvas.drawRect(MENU_X + 210, ry, 30, 30, canAdd ? 0x4488CCUL : 0x223344UL);
    canvas.setTextSize(2);
    canvas.setTextColor(canAdd ? 0xFFFFFFUL : 0x334455UL);
    canvas.setCursor(MENU_X + 217, ry + 7);
    canvas.print("+");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  loop
// ═══════════════════════════════════════════════════════════════════════════════
void loop() {
  // Physical button (disabled — GPIO0 is PCLK on this board)
  bool btnState = (BUTTON_PIN >= 0) ? digitalRead(BUTTON_PIN) : HIGH;
  if (btnState == LOW && lastBtnState == HIGH) {
    uint32_t t = millis();
    if (t - lastBtnMs > DEBOUNCE_MS) {
      lastBtnMs = t;
      dropFood();
    }
  }
  lastBtnState = btnState;

  // Touch handling
  uint16_t tx, ty;
  bool touched = display.getTouch(&tx, &ty);
  if (touched && !lastTouched) {
    if (tx >= HBTN_X && tx < (uint16_t)(HBTN_X + HBTN_W) &&
        ty >= HBTN_Y && ty < (uint16_t)(HBTN_Y + HBTN_H)) {
      // Hamburger button — toggle menu
      menuOpen = !menuOpen;
    } else if (menuOpen) {
      // Route to [-]/[+] buttons; block food drop while menu open
      const FishType rowType[3] = { FISH_PAIR, FISH_SCHOOL, FISH_SCHOOL2 };
      for (int row = 0; row < 3; row++) {
        int ry = MENU_Y + 45 + row * 58;
        if (tx >= (uint16_t)(MENU_X + 148) && tx < (uint16_t)(MENU_X + 178) &&
            ty >= (uint16_t)ry              && ty < (uint16_t)(ry + 30)) {
          removeFish(rowType[row]);
          break;
        }
        if (tx >= (uint16_t)(MENU_X + 210) && tx < (uint16_t)(MENU_X + 240) &&
            ty >= (uint16_t)ry              && ty < (uint16_t)(ry + 30)) {
          addFish(rowType[row]);
          break;
        }
      }
    } else {
      dropFood((int)tx, (int)ty);
    }
  }
  lastTouched = touched;

  uint32_t now = millis();
  if (now - lastFrameMs < FRAME_MS) return;
  lastFrameMs = now;
  tick += 1.0f;

  updateSnail();
  updateBubbles();
  updateFlakes();
  updateFish();

  drawBackground();
  drawFishShadows();
  drawSnail();
  drawSeaweed();
  drawBubbles();
  drawFlakes();
  drawFish();
  drawTankRim();
  drawMenuButton();
  drawMenu();
  canvas.pushSprite(0, 0);
}

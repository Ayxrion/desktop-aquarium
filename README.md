Download the updated LovyanGFX Library:
https://www.mediafire.com/file/c73qicl5uonfffs/New_Compressed_%2528zipped%2529_Folder.zip/file

Build on Pi:

sudo apt-get install libsdl2-dev libsdl2-gfx-dev libsdl2-ttf-dev libcurl4-openssl-dev fonts-dejavu-core
cd aquarium-pi && mkdir build && cd build
cmake .. && make -j$(nproc)
./aquarium

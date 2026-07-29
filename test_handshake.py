import asyncio
import struct
import threading
import time
from bleak import BleakScanner, BleakClient
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
from ctypes import cast, POINTER
from comtypes import CLSCTX_ALL
import pyautogui

pyautogui.FAILSAFE = False

# --- НАЛАШТУВАННЯ АУДІО WINDOWS ---
try:
    device = AudioUtilities.GetSpeakers()
    volume_control = device.EndpointVolume
except AttributeError:
    interface = AudioUtilities.GetSpeakers().Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    volume_control = cast(interface, POINTER(IAudioEndpointVolume))

# UUIDs
UUID_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
UUID_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
UUID_LED = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

INIT_STEP_1 = bytes([0x01, 0x00])
INIT_STEP_2 = bytes([0x20, 0x10, 0x00, 0xD0, 0x07, 0x34, 0x00, 0x03])


class TrikiMediaRemote:
    def __init__(self):
        self.last_action_time = 0
        self.cooldown = 0.35  # Кулдаун між жестами (секунди)

    def change_volume(self, delta):
        current_vol = volume_control.GetMasterVolumeLevelScalar()
        new_vol = max(0.0, min(1.0, current_vol + delta))
        volume_control.SetMasterVolumeLevelScalar(new_vol, None)
        print(f"🔊 Гучність: {int(new_vol * 100)}%")

    def handle_gesture(self, action):
        now = time.time()
        if now - self.last_action_time < self.cooldown:
            return

        if action == "NEXT_TRACK":
            pyautogui.press("nexttrack")
            print("⏭ Наступний трек")
        elif action == "PREV_TRACK":
            pyautogui.press("prevtrack")
            print("⏮ Попередній трек")
        elif action == "PLAY_PAUSE":
            pyautogui.press("playpause")
            print("⏯ Пауза / Відтворення")

        self.last_action_time = now

    def process_data(self, sender, data: bytearray):
        if len(data) < 8 or data[0] != 0x22:
            return

        x = struct.unpack('<h', data[2:4])[0]
        y = struct.unpack('<h', data[4:6])[0]
        z = struct.unpack('<h', data[6:8])[0]

        # 1. Обертання по осі Z -> Зміна гучності
        if z > 1500:
            self.change_volume(0.02)
        elif z < -1500:
            self.change_volume(-0.02)

        # 2. Нахил по осі X -> Перемикання треків
        if x > 2500:
            self.handle_gesture("NEXT_TRACK")
        elif x < -2500:
            self.handle_gesture("PREV_TRACK")

        # 3. Постукування або поштовх по осі Y -> Пауза / Play
        if abs(y) > 7500:
            self.handle_gesture("PLAY_PAUSE")


async def main():
    print("🔍 Пошук Triki...")
    devices = await BleakScanner.discover()
    triki = next((d for d in devices if d.name and "triki" in d.name.lower()), None)

    if not triki:
        print("❌ Triki не знайдено!")
        return

    print(f"✅ Знайдено: {triki.name}. Підключення...")

    async with BleakClient(triki.address) as client:
        print("🎉 Пульт підключено!")

        remote = TrikiMediaRemote()
        await client.start_notify(UUID_NOTIFY, remote.process_data)

        # Переконаємося, що світлодіод вимкнено для економії батареї
        try:
            await client.write_gatt_char(UUID_LED, bytes([0]), response=True)
        except Exception:
            pass

        # Активація сенсорів
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_1, response=False)
        await asyncio.sleep(0.1)
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_2, response=False)

        print("\n🎶 Пульт готовий до використання!")
        print(" 🔄 Крути -> Гучність")
        print(" ↔️ Нахиляй вбік -> Перемикання треків")
        print(" 💥 Стукни / потруси -> Пауза\n")

        while True:
            await asyncio.sleep(1)


def run_in_mta():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main())
    except KeyboardInterrupt:
        print("\n👋 Скрипт зупинено.")


if __name__ == "__main__":
    t = threading.Thread(target=run_in_mta)
    t.start()
    t.join()
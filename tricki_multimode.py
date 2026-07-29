import asyncio
import struct
import threading
import time
from bleak import BleakScanner, BleakClient
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

# --- НАЛАШТУВАННЯ АУДІО WINDOWS ---
try:
    device = AudioUtilities.GetSpeakers()
    volume_control = device.EndpointVolume
except AttributeError:
    interface = AudioUtilities.GetSpeakers().Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    volume_control = cast(interface, POINTER(IAudioEndpointVolume))

UUID_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
UUID_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
UUID_LED = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"
UUID_BATTERY = "00002a19-0000-1000-8000-00805f9b34fb"

INIT_STEP_1 = bytes([0x01, 0x00])
INIT_STEP_2 = bytes([0x20, 0x10, 0x00, 0xD0, 0x07, 0x34, 0x00, 0x03])

# Глобальний прапор для коректного виходу з циклів
stop_requested = False


class SmartVolumeRemote:
    def __init__(self):
        self.last_move_time = time.time()
        self.is_idle = False

    def change_volume(self, delta):
        current_vol = volume_control.GetMasterVolumeLevelScalar()
        new_vol = max(0.0, min(1.0, current_vol + delta))
        volume_control.SetMasterVolumeLevelScalar(new_vol, None)
        print(f"🔊 Гучність: {int(new_vol * 100)}%")

    def process_data(self, sender, data: bytearray):
        if len(data) < 8 or data[0] != 0x22:
            return

        z = struct.unpack('<h', data[6:8])[0]
        now = time.time()

        if abs(z) > 1500:
            self.last_move_time = now
            if self.is_idle:
                self.is_idle = False
                print("⚡ Triki прокинувся!")

            if z > 1500:
                self.change_volume(0.02)
            elif z < -1500:
                self.change_volume(-0.02)
        else:
            if not self.is_idle and (now - self.last_move_time > 30):
                self.is_idle = True
                print("💤 [ЕКО-РЕЖИМ] Triki у спокої, економимо батарейку CR2032...")


async def connect_and_run():
    global stop_requested
    print("🔍 Пошук Triki...")
    devices = await BleakScanner.discover()
    triki = next((d for d in devices if d.name and "triki" in d.name.lower()), None)

    if not triki:
        print("❌ Triki не знайдено! Перевірте, чи він прокинувся...")
        return False

    print(f"✅ Знайдено: {triki.name}. Підключення...")

    async with BleakClient(triki.address) as client:
        print("🎉 Розумний регулятор гучності підключено!")

        # 🔋 Читаємо рівень батареї
        try:
            battery_data = await client.read_gatt_char(UUID_BATTERY)
            print(f"🔋 Заряд батареї Triki: {battery_data[0]}%")
        except Exception:
            print("🔋 Не вдалося зчитати рівень батареї.")

        remote = SmartVolumeRemote()
        await client.start_notify(UUID_NOTIFY, remote.process_data)

        # Вимикаємо світлодіод
        try:
            await client.write_gatt_char(UUID_LED, bytes([0]), response=True)
        except Exception:
            pass

        # Активація сенсорів
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_1, response=False)
        await asyncio.sleep(0.1)
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_2, response=False)

        print("\n🥏 Готово! Обертай шайбу для зміни гучності.")
        print("💡 Для безпечного виходу натисніть Ctrl+C в консолі.\n")

        try:
            while client.is_connected and not stop_requested:
                await asyncio.sleep(0.2)
        finally:
            # Блок гарантованого безпечного роз'єднання
            if client.is_connected:
                print("\n🧹 Безпечне відключення від Triki...")
                try:
                    await client.stop_notify(UUID_NOTIFY)
                except Exception:
                    pass
                await client.disconnect()
                print("✅ Triki успішно відключено та переведено у сон!")

    return True


async def main():
    global stop_requested
    while not stop_requested:
        try:
            await connect_and_run()
        except asyncio.CancelledError:
            break
        except Exception as e:
            if not stop_requested:
                print(f"⚠️ Помилка з'єднання: {e}")

        if not stop_requested:
            print("⏳ Очікування 3 секунди перед наступним пошуком...\n")
            # Короткими кроками чекаємо, щоб миттєво зреагувати на Ctrl+C
            for _ in range(30):
                if stop_requested:
                    break
                await asyncio.sleep(0.1)


def run_in_mta():
    global stop_requested
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main())
    except (KeyboardInterrupt, SystemExit):
        stop_requested = True
        print("\n👋 Отримано сигнал зупинки (Ctrl+C). Вихід...")


if __name__ == "__main__":
    t = threading.Thread(target=run_in_mta)
    t.start()
    try:
        t.join()
    except KeyboardInterrupt:
        stop_requested = True
        print("\n👋 Завершення роботи програми. Бувай!")
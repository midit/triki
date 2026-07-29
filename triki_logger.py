import asyncio
import struct
import time
import csv
from datetime import datetime
from bleak import BleakScanner, BleakClient

# --- UUID (ті самі, що у твоєму робочому скрипті) ---
UUID_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
UUID_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
UUID_LED = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

INIT_STEP_1 = bytes([0x01, 0x00])
INIT_STEP_2 = bytes([0x20, 0x10, 0x00, 0xD0, 0x07, 0x34, 0x00, 0x03])

# --- Налаштування логування ---
LOG_SECONDS = 20          # скільки секунд писати після першого пакета
OUT_FILE = f"triki_log_{datetime.now():%Y%m%d_%H%M%S}.csv"

records = []               # сюди складаємо всі пакети
t0 = None                  # час першого пакета
last_t = None              # час попереднього пакета (для dt)
stop_flag = False


def parse_int16_channels(data: bytes):
    """Парсимо всі можливі int16 LE, починаючи з байта 2 (після заголовка 0x22 і data[1])."""
    channels = []
    # від offset=2, крок 2 байти, скільки влізе
    for off in range(2, len(data) - 1, 2):
        channels.append(struct.unpack('<h', data[off:off + 2])[0])
    return channels


def on_packet(sender, data: bytearray):
    global t0, last_t, stop_flag
    now = time.perf_counter()

    # цікавлять лише пакети сенсора 0x22
    if len(data) < 8 or data[0] != 0x22:
        return

    if t0 is None:
        t0 = now
        print(f"📥 Пішли дані! Пиши {LOG_SECONDS} c — крути шатун рівномірно рукою.\n")

    t_rel = now - t0
    dt_ms = (now - last_t) * 1000 if last_t is not None else 0.0
    last_t = now

    channels = parse_int16_channels(bytes(data))
    raw_hex = bytes(data).hex()

    records.append({
        "t": round(t_rel, 4),
        "dt_ms": round(dt_ms, 2),
        "len": len(data),
        "byte1": data[1],
        "channels": channels,
        "raw_hex": raw_hex,
    })

    # компактний живий вивід (кожен ~10-й пакет, щоб не спамити)
    if len(records) % 10 == 0:
        ch_str = " ".join(f"{c:6d}" for c in channels)
        print(f"  t={t_rel:5.2f}s  n={len(records):4d}  ch=[{ch_str}]")

    if t_rel >= LOG_SECONDS:
        stop_flag = True


async def main():
    print("🔍 Пошук Triki...")
    devices = await BleakScanner.discover()
    triki = next((d for d in devices if d.name and "triki" in d.name.lower()), None)
    if not triki:
        print("❌ Triki не знайдено. Прокинь його (поворуши) і спробуй ще раз.")
        return

    print(f"✅ Знайдено: {triki.name}. Підключення...")
    async with BleakClient(triki.address) as client:
        print("🎉 Підключено.")

        await client.start_notify(UUID_NOTIFY, on_packet)

        # вимикаємо світлодіод (як у твоєму скрипті)
        try:
            await client.write_gatt_char(UUID_LED, bytes([0]), response=True)
        except Exception:
            pass

        # активація сенсорів
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_1, response=False)
        await asyncio.sleep(0.1)
        await client.write_gatt_char(UUID_WRITE, INIT_STEP_2, response=False)

        print("⏳ Чекаю дані від сенсора...\n")

        # чекаємо або LOG_SECONDS даних, або Ctrl+C
        try:
            while client.is_connected and not stop_flag:
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            pass
        finally:
            try:
                await client.stop_notify(UUID_NOTIFY)
            except Exception:
                pass

    save_and_report()


def save_and_report():
    if not records:
        print("\n⚠️ Жодного пакета 0x22 не отримано. Перевір, чи крутив/ворушив Triki під час запуску.")
        return

    # к-сть каналів визначаємо за максимумом
    max_ch = max(len(r["channels"]) for r in records)

    with open(OUT_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        header = ["t", "dt_ms", "len", "byte1"] + [f"ch{i}" for i in range(max_ch)] + ["raw_hex"]
        w.writerow(header)
        for r in records:
            ch = r["channels"] + [""] * (max_ch - len(r["channels"]))
            w.writerow([r["t"], r["dt_ms"], r["len"], r["byte1"], *ch, r["raw_hex"]])

    # --- Підсумок ---
    total = len(records)
    duration = records[-1]["t"] if records else 0
    dts = [r["dt_ms"] for r in records if r["dt_ms"] > 0]
    mean_dt = sum(dts) / len(dts) if dts else 0
    hz = 1000.0 / mean_dt if mean_dt else 0
    lengths = sorted(set(r["len"] for r in records))

    print("\n" + "=" * 50)
    print("📊 ПІДСУМОК ЛОГУВАННЯ")
    print(f"   Пакетів:          {total}")
    print(f"   Тривалість:       {duration:.2f} c")
    print(f"   Частота семплів:  ~{hz:.1f} Гц (середній dt {mean_dt:.1f} мс)")
    print(f"   Довжина пакета:   {lengths} байт")
    print(f"   Каналів int16:    {max_ch}")
    print(f"   Файл:             {OUT_FILE}")
    print("=" * 50)
    print("\n➡️  Кинь мені цей CSV-файл — розберемо розкладку байтів і напишемо алгоритм каденсу.")
    print("💡 Якщо рахував оберти — напиши, скільки повних обертів шатуна зробив за час логу.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Зупинка (Ctrl+C).")
        save_and_report()

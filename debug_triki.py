import asyncio
import threading
from bleak import BleakScanner, BleakClient

UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"

def notification_handler(sender, data: bytearray):
    print(f"📥 Отримано дані ({len(data)} байт): {data.hex()} | raw: {list(data)}")

async def main():
    print("🔍 Пошук Triki...")
    devices = await BleakScanner.discover()
    triki = next((d for d in devices if d.name and "triki" in d.name.lower()), None)

    if not triki:
        print("❌ Triki не знайдено!")
        return

    print(f"✅ Підключення до {triki.name}...")
    async with BleakClient(triki.address) as client:
        print("🎉 Підключено! Починаємо аналіз сервісів та характеристик...")

        # Скануємо всі сервіси та характеристики
        for service in client.services:
            print(f"\n📦 Сервіс: {service.uuid}")
            for char in service.characteristics:
                print(f"   └── 🔑 Характеристика: {char.uuid} | Властивості: {char.properties}")
                
                # Підписуємося на всі характеристики, які підтримують notify або indicate
                if "notify" in char.properties or "indicate" in char.properties:
                    try:
                        await client.start_notify(char.uuid, notification_handler)
                        print(f"       ✅ Успішно підписано на сповіщення {char.uuid}")
                    except Exception as e:
                        print(f"       ⚠️ Не вдалося підписатися: {e}")

        print("\nКрутіть, нахиляйте або натискайте кнопку на Triki! Дивимося логи в консолі...")
        print("Для виходу натисніть Ctrl+C.\n")

        while True:
            await asyncio.sleep(1)

def run_in_mta():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(main())

if __name__ == "__main__":
    t = threading.Thread(target=run_in_mta)
    t.start()
    t.join()
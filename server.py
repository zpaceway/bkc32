import asyncio
from src.coordinator import serve
from src.collector import collector


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.create_task(serve())
    loop.create_task(collector.start())
    loop.run_forever()

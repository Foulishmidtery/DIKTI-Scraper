"""Entry point untuk executable Flask yang dijalankan Electron."""

from multiprocessing import freeze_support
import atexit

from backend.app import app
from backend.config import settings

if settings.secure_gateway:
    from backend.secure_gateway import gateway_client
    atexit.register(gateway_client.close)


if __name__ == "__main__":
    freeze_support()
    app.run(
        debug=False,
        use_reloader=False,
        host=settings.flask_host,
        port=settings.flask_port,
        threaded=True,
    )

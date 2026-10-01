import contextlib
from pathlib import Path

import streamlit as st

from proxy_bridge import NodeBackend, make_routes

backend = NodeBackend()


@contextlib.asynccontextmanager
async def lifespan(_app):
    await backend.start()
    try:
        yield
    finally:
        await backend.stop()


app = st.App(str(Path(__file__).with_name("ui.py")), routes=make_routes(backend), lifespan=lifespan)

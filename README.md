# opencode_proxy
opencode_proxy

## Streamlit Community Cloud

`streamlit_app.py` is the entrypoint. It starts `server.js` (Node) as a child process and forwards the API paths
(`/v1`, `/res`, `/chat`, `/mes`, `/kilo`, `/uncloseai`, `/dahl`, `/health`, `/ip`) to it through `st.App` routes
(Streamlit >= 1.64). Node comes from the `nodejs-wheel-binaries` package in `requirements.txt`; a system `node` is used if present.
The Streamlit UI at `/` is a placeholder page.

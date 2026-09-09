import worker from "./worker.js";

export async function onRequest(context) {
  const env = { PROXY_API_KEY: context.env?.PROXY_API_KEY };
  return await worker.fetch(context.request, env, context);
}

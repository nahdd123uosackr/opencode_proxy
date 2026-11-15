import { httpRouter } from "convex/server";
import { corsPreflight, currentKey, debug, embeddings, health, models, chatCompletions } from "./ai";
import { proxy } from "./proxy/handler";

const http = httpRouter();

http.route({ path: "/health", method: "GET", handler: health });
http.route({ path: "/debug", method: "GET", handler: debug });
http.route({ path: "/key", method: "GET", handler: currentKey });
http.route({ path: "/v1/models", method: "GET", handler: models });

http.route({ path: "/v1/chat/completions", method: "POST", handler: chatCompletions });
http.route({ path: "/v1/chat/completions", method: "OPTIONS", handler: corsPreflight });

http.route({ path: "/v1/embeddings", method: "POST", handler: embeddings });
http.route({ path: "/v1/embeddings", method: "OPTIONS", handler: corsPreflight });

http.route({ pathPrefix: "/v1/", method: "OPTIONS", handler: corsPreflight });

http.route({ pathPrefix: "/proxy/", method: "GET", handler: proxy });
http.route({ pathPrefix: "/proxy/", method: "POST", handler: proxy });
http.route({ pathPrefix: "/proxy/", method: "OPTIONS", handler: corsPreflight });

export default http;
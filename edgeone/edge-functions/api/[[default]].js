// EdgeOne Edge Functions API Handler - 기존 로직 래핑
import { handleRequest } from "./api_logic.js";

export default async (request, context) => {
  return await handleRequest(request, context);
};

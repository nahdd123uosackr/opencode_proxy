// EdgeOne Edge Functions Entry Point
import { handleRequest } from "./api/[[default]].js";

export default async (request, context) => {
  return await handleRequest(request, context);
};

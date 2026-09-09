const handler = require('../../../api/index.js'); // 기존 로직 import

export default async (request, context) => {
  // Convert EdgeOne/Web Standard Request to Node.js req/res-like object
  // EdgeOne Edge Functions가 요구하는 Response 형식으로 반환
  const url = new URL(request.url);
  
  // 간단한 API 매핑
  return await handler(request, context);
};

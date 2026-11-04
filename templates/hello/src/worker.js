// /api/* 進 Worker，其他路徑由 rucloud 直接回應 public/ 裡的檔案
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') {
      return Response.json({ message: `${env.GREETING}，${url.searchParams.get('name') || '世界'}` });
    }
    return new Response('not found', { status: 404 });
  },
};

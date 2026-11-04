export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({ from: 'hello', path: url.pathname, host: url.host });
  },
};

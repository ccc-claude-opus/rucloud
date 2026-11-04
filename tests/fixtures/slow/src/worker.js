export default {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    console.log(`handling ${pathname}`);
    if (pathname === '/slow') await new Promise((r) => setTimeout(r, 1500));
    if (pathname === '/oops') console.error('something went wrong');
    return new Response(`done ${pathname}`);
  },
};

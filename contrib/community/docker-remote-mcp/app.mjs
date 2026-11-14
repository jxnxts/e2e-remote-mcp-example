import { createServer } from 'node:http';

/** Starts a synthetic app on an ephemeral loopback port; state lives in each browser. */
export async function startApp() {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Synthetic citizen desk</title>
      <h1>Synthetic citizen desk</h1><label>Request <input id="request"></label>
      <button onclick="localStorage.setItem('request',document.querySelector('input').value); document.querySelector('[role=status]').textContent='Received: '+localStorage.getItem('request')">Submit</button>
      <p role="status">Ready</p><script>if(localStorage.getItem('request')) document.querySelector('[role=status]').textContent='Received: '+localStorage.getItem('request')</script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}

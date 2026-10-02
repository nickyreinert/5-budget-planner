// Connects the app to the local MCP server (`node mcp/server.mjs --live`).
// Long-polls it for commands, runs them through `handle` and posts the
// outcome back. Returns a function that stops the loop.
const RETRY_MS = 2000;

export function start_live_bridge({ url, handle, on_status }) {
  const controller = new AbortController();
  const { signal } = controller;
  const post = body => fetch(`${url}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
  });
  (async () => {
    while (!signal.aborted) {
      try {
        await fetch(`${url}/ping`, { signal });
        on_status('connected');
        const response = await fetch(`${url}/poll`, { signal });
        if (response.status !== 200) continue;
        const command = await response.json();
        try { await post({ id: command.id, ok: true, value: await handle(command) }); }
        catch (error) { await post({ id: command.id, ok: false, error: error.message }); }
      } catch (error) {
        if (signal.aborted) return;
        on_status('disconnected');
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
  return () => controller.abort();
}

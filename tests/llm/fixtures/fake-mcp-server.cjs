// Newline-delimited JSON-RPC 2.0 fake MCP server for mcpClient tests. Speaks just enough of
// the protocol to exercise the client: initialize handshake, tools/list, tools/call — plus the
// failure shapes the client must survive (isError results, a reply split mid-JSON across two
// stdout writes, and dying without replying).
const readline = require('node:readline');

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '0.0.0' },
        },
      });
      return;
    case 'notifications/initialized':
      return; // notification: no reply
    case 'tools/list':
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: [
            {
              name: 'echo', description: 'echoes its arguments back as JSON text',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
            { name: 'fail', description: 'always returns an isError result', inputSchema: { type: 'object' } },
            { name: 'slow', description: 'replies whole after a delay', inputSchema: { type: 'object' } },
            { name: 'split', description: 'reply split mid-JSON across two writes', inputSchema: { type: 'object' } },
            { name: 'die', description: 'exits without replying', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } });
      } else if (name === 'fail') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
      } else if (name === 'slow') {
        setTimeout(() => send({
          jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow' }] },
        }), 50);
      } else if (name === 'split') {
        const whole = `${JSON.stringify({
          jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'reassembled' }] },
        })}\n`;
        const cut = Math.floor(whole.length / 2);
        process.stdout.write(whole.slice(0, cut));
        setTimeout(() => process.stdout.write(whole.slice(cut)), 30);
      } else if (name === 'die') {
        process.exit(7);
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
      }
      return;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
  }
});

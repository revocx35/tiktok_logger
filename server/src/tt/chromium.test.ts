import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromiumLink } from './chromium.js';

/**
 * The VNC tunnel is an HTTP Upgrade whose name the Go manager validates exactly (`chromium/manager/server.go`):
 * anything else is answered with 400 and the browser UI then spends its life saying "connection lost". The two sides
 * live in different languages, so pin the header here rather than trusting the rename to have reached both.
 */
describe('ChromiumLink.openVncTunnel', () => {
  let server: http.Server;
  let base = '';
  const seen: { upgrade?: string; path?: string; auth?: string } = {};
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(426).end('upgrade required');
    });
    server.on('upgrade', (req, socket: net.Socket) => {
      seen.upgrade = req.headers.upgrade;
      seen.path = req.url;
      seen.auth = req.headers.authorization;
      if (req.headers.upgrade !== 'ttl-tunnel' || !req.headers.authorization) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ttl-tunnel\r\n\r\n');
      socket.write('RFB 003.008\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('sends Upgrade: ttl-tunnel with the instance token and yields the raw x11vnc stream', async () => {
    const link = new ChromiumLink(base, 1, 'instance-token-0123456789');
    const tunnel = await link.openVncTunnel(2000);
    expect(seen.upgrade).toBe('ttl-tunnel');
    expect(seen.path).toBe('/i/1/vnc');
    expect(seen.auth).toBe('Bearer instance-token-0123456789');

    const first = await new Promise<string>((resolve) => {
      tunnel.once('data', (b: Buffer) => resolve(b.toString('latin1')));
    });
    expect(first).toBe('RFB 003.008\n');
    tunnel.destroy();
  });

  it('reports a refused tunnel as an error instead of hanging', async () => {
    const link = new ChromiumLink(base, 1, undefined);
    await expect(link.openVncTunnel(2000)).rejects.toThrow(/400|refused/i);
  });
});

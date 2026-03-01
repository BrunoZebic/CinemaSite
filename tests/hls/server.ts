import http from "node:http";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

type StartServerOptions = {
  port?: number;
  bindHost?: string;
  originHost?: string;
};

export async function startHlsTestServer(options: StartServerOptions = {}) {
  const port = Number(options.port ?? process.env.HLS_SMOKE_PORT ?? 4173);
  const bindHost = options.bindHost ?? "127.0.0.1";
  const originHost = options.originHost ?? "localhost";
  const hlsPath = path.resolve(process.cwd(), "node_modules/hls.js/dist/hls.min.js");
  const pagePath = path.resolve(process.cwd(), "tests/hls/player.html");

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing URL");
        return;
      }

      if (req.url.startsWith("/hls.min.js")) {
        const js = await readFile(hlsPath);
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(js);
        return;
      }

      if (req.url.startsWith("/player.html")) {
        const html = await readFile(pagePath);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500);
      res.end(message);
    }
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} in use. Stop the other process or set HLS_SMOKE_PORT.`,
          ),
        );
        return;
      }
      reject(error);
    };

    server.once("error", onError);
    server.listen(
      {
        port,
        host: bindHost,
      },
      () => {
        server.removeListener("error", onError);
        resolve();
      },
    );
  });

  const baseUrl = `http://${originHost}:${port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

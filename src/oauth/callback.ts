import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface OAuthCallbackResult {
  code: string;
  location?: string;
  accountsServer?: string;
}

export interface OAuthCallbackListener {
  redirectUri: string;
  result: Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

interface OAuthCallbackListenerOptions {
  expectedState: string;
  callbackPath: string;
  redirectHostname?: '127.0.0.1' | 'localhost';
  port?: number;
  timeoutMs?: number;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });

const stateMatches = (actual: string | null, expected: string): boolean => {
  if (actual === null) return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

const validateCallbackPath = (path: string): string => {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    throw new Error('OAuth callback path must be an absolute URL path');
  }
  return path;
};

export async function createOAuthCallbackListener({
  expectedState,
  callbackPath,
  redirectHostname = '127.0.0.1',
  port = 8765,
  timeoutMs = 5 * 60_000
}: OAuthCallbackListenerOptions): Promise<OAuthCallbackListener> {
  const acceptedPath = validateCallbackPath(callbackPath);
  let resolveResult!: (value: OAuthCallbackResult) => void;
  let rejectResult!: (error: Error) => void;
  let settled = false;

  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = createServer({ maxHeaderSize: 8 * 1024, requireHostHeader: true }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    const rawRequestUrl = request.url ?? '';
    if (
      !rawRequestUrl.startsWith('/')
      || rawRequestUrl.startsWith('//')
      || rawRequestUrl.includes('\\')
      || rawRequestUrl.includes('#')
      || rawRequestUrl.length > 4_096
    ) {
      response.writeHead(rawRequestUrl.length > 4_096 ? 414 : 400).end('Invalid OAuth callback request.');
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(rawRequestUrl, 'http://127.0.0.1');
    } catch {
      response.writeHead(400).end('Invalid OAuth callback request.');
      return;
    }
    if (requestUrl.pathname !== acceptedPath || settled) {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end('Method not allowed.');
      return;
    }

    for (const name of ['state', 'code', 'error', 'error_description', 'location', 'accounts-server']) {
      if (requestUrl.searchParams.getAll(name).length > 1) {
        response.writeHead(400).end(`Duplicate OAuth callback parameter: ${name}.`);
        return;
      }
    }

    if (!stateMatches(requestUrl.searchParams.get('state'), expectedState)) {
      response.writeHead(400).end('OAuth state validation failed. Return to the terminal and try again.');
      return;
    }

    const finishAndStop = (): void => {
      response.once('finish', () => {
        server.closeIdleConnections();
        void closeServer(server);
      });
    };

    if (requestUrl.searchParams.has('error')) {
      settled = true;
      response.writeHead(400).end('Authorization was not completed. Return to the terminal.');
      rejectResult(new Error('OAuth authorization was denied or failed'));
      finishAndStop();
      return;
    }

    const authorizationCode = requestUrl.searchParams.get('code');
    if (!authorizationCode) {
      response.writeHead(400).end('Authorization code is missing. Return to the terminal and try again.');
      return;
    }

    const callbackResult: OAuthCallbackResult = { code: authorizationCode };
    const location = requestUrl.searchParams.get('location');
    const accountsServer = requestUrl.searchParams.get('accounts-server');
    if (location) callbackResult.location = location;
    if (accountsServer) callbackResult.accountsServer = accountsServer;

    settled = true;
    response.writeHead(200).end('Authorization complete. You may close this tab and return to the terminal.');
    resolveResult(callbackResult);
    finishAndStop();
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not determine OAuth callback listener address');
  }

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(new Error('OAuth callback timed out'));
    }
    void closeServer(server);
  }, timeoutMs);
  timer.unref();

  return {
    redirectUri: `http://${redirectHostname}:${address.port}${acceptedPath}`,
    result,
    async close() {
      clearTimeout(timer);
      await closeServer(server);
    }
  };
}

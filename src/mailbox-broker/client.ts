import { createConnection } from 'node:net';
import {
  MAILBOX_SOCKET_PATH,
  MAX_RESPONSE_BYTES,
  MailboxResponseSchema,
  type MailboxRequest,
  type MailboxResponse
} from './protocol.js';

export async function callMailboxBroker(
  request: MailboxRequest,
  socketPath = MAILBOX_SOCKET_PATH
): Promise<MailboxResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let response = Buffer.alloc(0);
    const fail = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Mailbox broker unavailable'));
    };

    socket.setTimeout(20_000, fail);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) fail();
    });
    socket.once('error', fail);
    socket.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = MailboxResponseSchema.parse(JSON.parse(response.toString('utf8')));
        if (parsed.id !== request.id) throw new Error('mismatch');
        resolve(parsed);
      } catch {
        reject(new Error('Mailbox broker returned an invalid response'));
      }
    });
  });
}

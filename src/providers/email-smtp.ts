import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

const SMTP_TIMEOUT_MS = 30_000;

export interface SmtpMessage {
  from: string;
  to: string | string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html: string;
}

export interface SmtpSendInfo {
  messageId?: unknown;
  accepted?: unknown;
  rejected?: unknown;
}

export interface SmtpTransport {
  sendMail(message: SmtpMessage): Promise<SmtpSendInfo>;
}

export type SmtpTransportOptions = SMTPTransport.Options;
export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

export interface SmtpConnectionConfig {
  host: string;
  port: number;
  tlsMode: 'implicit' | 'starttls';
  username: string;
  password: string;
}

export function buildSmtpTransportOptions(config: SmtpConnectionConfig): SmtpTransportOptions {
  const implicitTls = config.tlsMode === 'implicit';
  return {
    host: config.host,
    port: config.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { servername: config.host, rejectUnauthorized: true }
  };
}

const createSmtpTransport: SmtpTransportFactory = (options) =>
  nodemailer.createTransport(options) as unknown as SmtpTransport;

const escapeHeaderValue = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const formatMailbox = (email: string, displayName?: string): string => {
  const cleanEmail = escapeHeaderValue(email);
  const cleanName = displayName ? escapeHeaderValue(displayName) : '';
  if (!cleanName) return cleanEmail;
  const quotedName = cleanName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quotedName}" <${cleanEmail}>`;
};

const recipientLabel = (count: number): string => count === 1 ? 'recipient' : 'recipients';

export class SmtpEmailProvider implements Provider {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly providerConfig: Extract<ProviderConfig, { type: 'email-smtp' }>,
    transportFactory: SmtpTransportFactory = createSmtpTransport
  ) {
    this.transport = transportFactory(buildSmtpTransportOptions(providerConfig));
  }

  describeSender(): string {
    return formatMailbox(this.providerConfig.fromAddress, this.providerConfig.displayName);
  }

  async send(draft: Draft): Promise<ProviderResult> {
    if (draft.type !== 'email') {
      throw new Error('email-smtp provider only supports email drafts');
    }

    const payload = draft.payload as {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
    };

    let info: SmtpSendInfo;
    try {
      info = await this.transport.sendMail({
        from: this.describeSender(),
        to: payload.to,
        cc: payload.cc ?? [],
        bcc: payload.bcc ?? [],
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
        subject: payload.subject,
        html: payload.body
      });
    } catch {
      throw new Error('SMTP send failed');
    }

    const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
    if (acceptedCount === 0) {
      throw new Error('SMTP send failed');
    }
    const rejectedCount = Array.isArray(info.rejected) ? info.rejected.length : 0;
    const rawMessageId = typeof info.messageId === 'string' ? info.messageId.trim() : '';
    const messageId = rawMessageId
      && rawMessageId.length <= 512
      && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(rawMessageId)
      ? rawMessageId
      : undefined;
    const partial = rejectedCount > 0 ? `; ${rejectedCount} rejected` : '';

    return {
      providerMessageId: messageId,
      details: `Email accepted by SMTP for ${acceptedCount} ${recipientLabel(acceptedCount)}${partial}`
    };
  }
}
